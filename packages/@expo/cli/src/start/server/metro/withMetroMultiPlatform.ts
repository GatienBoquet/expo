/**
 * Copyright © 2022 650 Industries.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
import chalk from 'chalk';
import fs from 'fs';
import { ConfigT } from 'metro-config';
import { Resolution, ResolutionContext } from 'metro-resolver';
import path from 'path';
import resolveFrom from 'resolve-from';

import {
  EXTERNAL_REQUIRE_NATIVE_POLYFILL,
  EXTERNAL_REQUIRE_POLYFILL,
  getNodeExternalModuleId,
  isNodeExternal,
  setupNodeExternals,
} from './externals';
import { isFailedToResolveNameError, isFailedToResolvePathError } from './metroErrors';
import { importMetroResolverFromProject } from './resolveFromProject';
import { getAppRouterRelativeEntryPath } from './router';
import { withMetroResolvers } from './withMetroResolvers';
import { Log } from '../../../log';
import { FileNotifier } from '../../../utils/FileNotifier';
import { env } from '../../../utils/env';
import { installExitHooks } from '../../../utils/exit';
import { isInteractive } from '../../../utils/interactive';
import { learnMore } from '../../../utils/link';
import { loadTsConfigPathsAsync, TsConfigPaths } from '../../../utils/tsconfig/loadTsConfigPaths';
import { resolveWithTsConfigPaths } from '../../../utils/tsconfig/resolveWithTsConfigPaths';
import { WebSupportProjectPrerequisite } from '../../doctor/web/WebSupportProjectPrerequisite';
import { PlatformBundlers } from '../platformBundlers';
import { getBareExtensions } from '@expo/config/paths';
const otherResolve = require('resolve') as typeof import('resolve');

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

const debug = require('debug')('expo:start:server:metro:multi-platform') as typeof console.log;

function withWebPolyfills(config: ConfigT, projectRoot: string): ConfigT {
  const originalGetPolyfills = config.serializer.getPolyfills
    ? config.serializer.getPolyfills.bind(config.serializer)
    : () => [];

  const getPolyfills = (ctx: { platform: string | null }): readonly string[] => {
    if (ctx.platform === 'web') {
      return [
        // NOTE: We might need this for all platforms
        path.join(projectRoot, EXTERNAL_REQUIRE_POLYFILL),
        // TODO: runtime polyfills, i.e. Fast Refresh, error overlay, React Dev Tools...
      ];
    }
    // Generally uses `rn-get-polyfills`
    const polyfills = originalGetPolyfills(ctx);

    return [...polyfills, EXTERNAL_REQUIRE_NATIVE_POLYFILL];
  };

  return {
    ...config,
    serializer: {
      ...config.serializer,
      getPolyfills,
    },
  };
}

function normalizeSlashes(p: string) {
  return p.replace(/\\/g, '/');
}

export function getNodejsExtensions(srcExts: readonly string[]): string[] {
  const mjsExts = srcExts.filter((ext) => /mjs$/.test(ext));
  const nodejsSourceExtensions = srcExts.filter((ext) => !/mjs$/.test(ext));
  // find index of last `*.js` extension
  const jsIndex = nodejsSourceExtensions.reduce((index, ext, i) => {
    return /jsx?$/.test(ext) ? i : index;
  }, -1);

  // insert `*.mjs` extensions after `*.js` extensions
  nodejsSourceExtensions.splice(jsIndex + 1, 0, ...mjsExts);

  return nodejsSourceExtensions;
}

/**
 * Apply custom resolvers to do the following:
 * - Disable `.native.js` extensions on web.
 * - Alias `react-native` to `react-native-web` on web.
 * - Redirect `react-native-web/dist/modules/AssetRegistry/index.js` to `@react-native/assets/registry.js` on web.
 * - Add support for `tsconfig.json`/`jsconfig.json` aliases via `compilerOptions.paths`.
 */
export function withExtendedResolver(
  config: ConfigT,
  {
    projectRoot,
    tsconfig,
    platforms,
    isTsconfigPathsEnabled,
  }: {
    projectRoot: string;
    tsconfig: TsConfigPaths | null;
    platforms: string[];
    isTsconfigPathsEnabled?: boolean;
  }
) {
  // Get the `transformer.assetRegistryPath`
  // this needs to be unified since you can't dynamically
  // swap out the transformer based on platform.
  const assetRegistryPath = fs.realpathSync(
    // This is the native asset registry alias for native.
    path.resolve(
      resolveFrom(projectRoot, 'react-native/Libraries/Image/AssetRegistry')
      // resolveFrom(projectRoot, '@expo/cli/dist/compiled/react-native/Libraries/Image/AssetRegistry')
    )
    // path.resolve(resolveFrom(projectRoot, 'react-native/Libraries/Image/AssetRegistry'))
    // NOTE(EvanBacon): This is the newer import but it doesn't work in the expo/expo monorepo.
    // path.resolve(resolveFrom(projectRoot, '@react-native/assets/registry.js'))
  );

  let reactNativeWebAppContainer: string | null = null;
  try {
    reactNativeWebAppContainer = fs.realpathSync(
      // This is the native asset registry alias for native.
      path.resolve(resolveFrom(projectRoot, 'expo-router/build/fork/react-native-web-container'))
      // NOTE(EvanBacon): This is the newer import but it doesn't work in the expo/expo monorepo.
      // path.resolve(resolveFrom(projectRoot, '@react-native/assets/registry.js'))
    );
  } catch {}

  const isWebEnabled = platforms.includes('web');

  // const { resolve: resolveWithMetro } = importMetroResolverFromProject(projectRoot);

  // const pkgJsonCache: Map<string, any> = new Map();

  // const readPackageSync: (
  //   readFileSync: (file: string) => string | { toString(): string },
  //   pkgfile: string
  // ) => Record<string, unknown> = (readFileSync, pkgfile) => {
  //   // TODO: Invalidate cache when package.json changes.
  //   if (pkgJsonCache.has(pkgfile)) {
  //     return pkgJsonCache.get(pkgfile);
  //   }
  //   // @ts-expect-error: This is what they do internally.
  //   const pkg = JSON.parse(readFileSync(pkgfile));
  //   pkgJsonCache.set(pkgfile, pkg);
  //   return pkg;
  // };

  function fastResolve(
    context: ResolutionContext,
    moduleName: string,
    platform: string | null
  ): Resolution {
    // TODO: Add improved error handling.
    const fp = otherResolve.sync(moduleName, {
      // basedir: context.unstable_getRealPath,
      basedir: path.dirname(context.originModulePath),
      extensions: context.sourceExts,
      // Used to ensure files trace to packages instead of node_modules in expo/expo. This is how Metro works and
      // the app doesn't finish without it.
      preserveSymlinks: false,
      readPackageSync: (readFileSync, pkgFile) => {
        return context.getPackage(pkgFile) ?? JSON.parse(readFileSync(pkgfile));
      },
      moduleDirectory: context.nodeModulesPaths,
      // readPackageSync,
      // moduleDirectory: ['packages', 'node_modules'],
      packageFilter(pkg) {
        // set the pkg.main to the first available field in context.mainFields
        for (const field of context.mainFields) {
          if (pkg[field] && typeof pkg[field] === 'string') {
            // object-inspect uses browser: {} in package.json
            pkg.main = pkg[field];
            break;
          }
        }
        return pkg;
      },

      // Not needed but added for parity...

      // @ts-ignore
      realpathSync: context.unstable_getRealPath,
    });

    if (context.sourceExts.some((ext) => fp.endsWith(ext))) {
      // TODO: Support `browser: { "util.inspect.js": false }` in package.json
      if (fp.endsWith('object-inspect/util.inspect.js')) {
        return {
          type: 'empty',
        };
      }
      // if (sourcesRegExp.test(fp)) {
      return {
        type: 'sourceFile',
        filePath: fp,
      };
    } else {
      // TODO: Asset extensions...
      return {
        type: 'assetFiles',
        filePaths: [fp],
      };
    }
  }

  const extraNodeModules: { [key: string]: Record<string, string> } = {};

  const aliases: { [key: string]: Record<string, string> } = {
    web: {
      'react-native': 'react-native-web',
      'react-native/index': 'react-native-web',
    },
  };

  if (isWebEnabled) {
    // Allow `react-native-web` to be optional when web is not enabled but path aliases is.
    extraNodeModules['web'] = {
      'react-native': path.resolve(require.resolve('react-native-web/package.json'), '..'),
    };
  }

  const preferredMainFields: { [key: string]: string[] } = {
    // Defaults from Expo Webpack. Most packages using `react-native` don't support web
    // in the `react-native` field, so we should prefer the `browser` field.
    // https://github.com/expo/router/issues/37
    web: ['browser', 'module', 'main'],
  };

  let tsConfigResolve = tsconfig?.paths
    ? resolveWithTsConfigPaths.bind(resolveWithTsConfigPaths, {
        paths: tsconfig.paths ?? {},
        baseUrl: tsconfig.baseUrl,
      })
    : null;

  if (isTsconfigPathsEnabled && isInteractive()) {
    // TODO: We should track all the files that used imports and invalidate them
    // currently the user will need to save all the files that use imports to
    // use the new aliases.
    const configWatcher = new FileNotifier(projectRoot, ['./tsconfig.json', './jsconfig.json']);
    configWatcher.startObserving(() => {
      debug('Reloading tsconfig.json');
      loadTsConfigPathsAsync(projectRoot).then((tsConfigPaths) => {
        if (tsConfigPaths?.paths && !!Object.keys(tsConfigPaths.paths).length) {
          debug('Enabling tsconfig.json paths support');
          tsConfigResolve = resolveWithTsConfigPaths.bind(resolveWithTsConfigPaths, {
            paths: tsConfigPaths.paths ?? {},
            baseUrl: tsConfigPaths.baseUrl,
          });
        } else {
          debug('Disabling tsconfig.json paths support');
          tsConfigResolve = null;
        }
      });
    });

    // TODO: This probably prevents the process from exiting.
    installExitHooks(() => {
      configWatcher.stopObserving();
    });
  } else {
    debug('Skipping tsconfig.json paths support');
  }

  let nodejsSourceExtensions: string[] | null = null;

  const sourceExtsConfig = { isTS: true, isReact: true, isModern: true };
  const sourceExts = getBareExtensions(['ios', 'native'], sourceExtsConfig).map((v) => '.' + v);
  const sourceExtsWithoutMjs = getBareExtensions(['ios', 'native'], {
    ...sourceExtsConfig,
    isModern: false,
  }).map((v) => '.' + v);

  const sourceExtsEndsWithRegex = new RegExp(`(${sourceExts.join('|')})$`);
  const sourceExtsWithoutMjsEndsWithRegex = new RegExp(`(${sourceExtsWithoutMjs.join('|')})$`);

  return withMetroResolvers(config, projectRoot, [
    // Add a resolver to alias the web asset resolver.
    (immutableContext: ResolutionContext, moduleName: string, platform: string | null) => {
      let context = {
        ...immutableContext,
      } as Mutable<ResolutionContext> & {
        mainFields: string[];
        customResolverOptions?: Record<string, string>;
      };

      const environment = context.customResolverOptions?.environment;
      const isNode = environment === 'node';

      // TODO: We need to prevent the require.context from including API routes as these use externals.
      // Should be fine after async routes lands.
      if (isNode) {
        const moduleId = isNodeExternal(moduleName);
        if (moduleId) {
          moduleName = getNodeExternalModuleId(context.originModulePath, moduleId);
          debug(`Redirecting Node.js external "${moduleId}" to "${moduleName}"`);
        }

        // Adjust nodejs source extensions to sort mjs after js, including platform variants.
        if (nodejsSourceExtensions === null) {
          nodejsSourceExtensions = getNodejsExtensions(context.sourceExts);
        }
        context.sourceExts = nodejsSourceExtensions;
      }

      // Conditionally remap `react-native` to `react-native-web` on web in
      // a way that doesn't require Babel to resolve the alias.
      if (platform && platform in aliases && aliases[platform][moduleName]) {
        moduleName = aliases[platform][moduleName];
      }

      // TODO: We may be able to remove this in the future, it's doing no harm
      // by staying here.
      // Conditionally remap `react-native` to `react-native-web`
      if (platform && platform in extraNodeModules) {
        context.extraNodeModules = {
          ...extraNodeModules[platform],
          ...context.extraNodeModules,
        };
      }

      if (tsconfig?.baseUrl && isTsconfigPathsEnabled) {
        context = {
          ...context,
          nodeModulesPaths: [
            ...immutableContext.nodeModulesPaths,
            // add last to ensure node modules are resolved first
            tsconfig.baseUrl,
          ],
        };
      }

      let mainFields: string[] = context.mainFields;

      if (isNode) {
        // Node.js runtimes should only be importing main at the moment.
        // This is a temporary fix until we can support the package.json exports.
        mainFields = ['main', 'module'];
      } else if (env.EXPO_METRO_NO_MAIN_FIELD_OVERRIDE) {
        mainFields = context.mainFields;
      } else if (platform && platform in preferredMainFields) {
        mainFields = preferredMainFields[platform];
      }
      function doResolve(moduleName: string): Resolution | null {
        // return resolveWithMetro(
        return fastResolve(
          {
            ...context,
            resolveRequest: undefined,
            mainFields,
            sourceExts: sources,

            // Passing `mainFields` directly won't be considered (in certain version of Metro)
            // we need to extend the `getPackageMainPath` directly to
            // use platform specific `mainFields`.
            // @ts-ignore
            // getPackageMainPath(packageJsonPath) {
            //   // @ts-expect-error: mainFields is not on type
            //   const package_ = context.moduleCache.getPackage(packageJsonPath);
            //   return package_.getMain(mainFields);
            // },
          },
          moduleName,
          platform
        );
      }

      function optionalResolve(moduleName: string): Resolution | null {
        try {
          return doResolve(moduleName);
        } catch (error) {
          // If the error is directly related to a resolver not being able to resolve a module, then
          // we can ignore the error and try the next resolver. Otherwise, we should throw the error.
          const isResolutionError =
            isFailedToResolveNameError(error) || isFailedToResolvePathError(error);
          if (!isResolutionError) {
            throw error;
          }
        }
        return null;
      }

      let result: Resolution | null = null;
      let sources = sourceExts;
      let sourcesRegExp = sourceExtsEndsWithRegex;

      // React Native uses `event-target-shim` incorrectly and this causes the native runtime
      // to fail to load. This is a temporary workaround until we can fix this upstream.
      // https://github.com/facebook/react-native/pull/38628
      if (
        moduleName.includes('event-target-shim') &&
        context.originModulePath.includes(path.sep + 'react-native' + path.sep)
      ) {
        sources = sourceExtsWithoutMjs;
        sourcesRegExp = sourceExtsWithoutMjsEndsWithRegex;
        // context.sourceExts = context.sourceExts.filter((f) => !f.includes('mjs'));
        debug('Skip mjs support for event-target-shim in:', context.originModulePath);
      }

      if (tsConfigResolve) {
        result = tsConfigResolve(
          {
            originModulePath: context.originModulePath,
            moduleName,
          },
          optionalResolve
        );
      }

      if (
        // is web
        platform === 'web' &&
        // Not server runtime
        !isNode &&
        // Is Node.js built-in
        isNodeExternal(moduleName)
      ) {
        // Perform optional resolve first. If the module doesn't exist (no module in the node_modules)
        // then we can mock the file to use an empty module.
        result ??= optionalResolve(moduleName);

        if (!result) {
          // In this case, mock the file to use an empty module.
          return {
            type: 'empty',
          };
        }
      }

      for (const alias of [
        'react-native',
        'expo-modules-core',
        // 'react-native-screens',
        'react-freeze',
        // 'react-native-safe-area-context',
        // 'deprecated-react-native-prop-types',
        // '@react-native/virtualized-lists',
        // '@react-native-masked-view/masked-view',
        'pretty-format',
      ]) {
        if (moduleName === alias) {
          moduleName = '@expo/cli/dist/compiled/' + alias;
          break;
        } else if (moduleName.startsWith(alias + '/')) {
          moduleName = moduleName.replace(
            new RegExp(`^${alias}\/(.*)`),
            // /react-native\/(.*)/,
            `@expo/cli/dist/compiled/${alias}/$1`
          );
          break;
        }
      }

      // if (moduleName === 'metro-runtime') {
      //   moduleName = '@expo/cli/dist/compiled/metro-runtime/src';
      // } else if (moduleName.startsWith('metro-runtime' + '/')) {
      //   moduleName = moduleName.replace(
      //     new RegExp(`^${'metro-runtime'}\/(.*)`),
      //     `@expo/cli/dist/compiled/${'metro-runtime'}/$1`
      //   );
      // }

      result ??= doResolve(moduleName);

      if (result) {
        // if (result.type !== 'sourceFile') {
        //   console.log('??', moduleName, fp, result);
        // }
        if (result.type === 'sourceFile') {
          // console.log('RN >', moduleName, context.originModulePath, result.filePath);
        }

        // Replace the web resolver with the original one.
        // This is basically an alias for web-only.
        if (shouldAliasAssetRegistryForWeb(platform, result)) {
          // @ts-expect-error: `readonly` for some reason.
          result.filePath = assetRegistryPath;
        }

        // React Native Web adds a couple extra divs for no reason, these
        // make static rendering much harder as we expect the root element to be `<html>`.
        // This resolution will alias to a simple in-out component to avoid React Native web.
        if (
          // Only apply the transform if expo-router is present.
          reactNativeWebAppContainer &&
          shouldAliasModule(
            {
              platform,
              result,
            },
            {
              platform: 'web',
              output: 'react-native-web/dist/exports/AppRegistry/AppContainer.js',
            }
          )
        ) {
          // @ts-expect-error: `readonly` for some reason.
          result.filePath = reactNativeWebAppContainer;
        }
      }

      return result;
    },
  ]);
}

/** @returns `true` if the incoming resolution should be swapped on web. */
export function shouldAliasAssetRegistryForWeb(
  platform: string | null,
  result: Resolution
): boolean {
  return (
    platform === 'web' &&
    result?.type === 'sourceFile' &&
    typeof result?.filePath === 'string' &&
    normalizeSlashes(result.filePath).endsWith(
      'react-native-web/dist/modules/AssetRegistry/index.js'
    )
  );
}
/** @returns `true` if the incoming resolution should be swapped. */
export function shouldAliasModule(
  input: {
    platform: string | null;
    result: Resolution;
  },
  alias: { platform: string; output: string }
): boolean {
  return (
    input.platform === alias.platform &&
    input.result?.type === 'sourceFile' &&
    typeof input.result?.filePath === 'string' &&
    normalizeSlashes(input.result.filePath).endsWith(alias.output)
  );
}

/** Add support for `react-native-web` and the Web platform. */
export async function withMetroMultiPlatformAsync(
  projectRoot: string,
  {
    config,
    platformBundlers,
    isTsconfigPathsEnabled,
    webOutput,
    routerDirectory,
  }: {
    config: ConfigT;
    isTsconfigPathsEnabled: boolean;
    platformBundlers: PlatformBundlers;
    webOutput?: 'single' | 'static' | 'server';
    routerDirectory: string;
  }
) {
  // Auto pick app entry for router.
  process.env.EXPO_ROUTER_APP_ROOT = getAppRouterRelativeEntryPath(projectRoot, routerDirectory);

  // Required for @expo/metro-runtime to format paths in the web LogBox.
  process.env.EXPO_PUBLIC_PROJECT_ROOT = process.env.EXPO_PUBLIC_PROJECT_ROOT ?? projectRoot;

  if (['static', 'server'].includes(webOutput ?? '')) {
    // Enable static rendering in runtime space.
    process.env.EXPO_PUBLIC_USE_STATIC = '1';
  }

  // Ensure the cache is invalidated if these values change.
  // @ts-expect-error
  config.transformer._expoRouterRootDirectory = process.env.EXPO_ROUTER_APP_ROOT;
  // @ts-expect-error
  config.transformer._expoRouterWebRendering = webOutput;
  // TODO: import mode

  if (platformBundlers.web === 'metro') {
    await new WebSupportProjectPrerequisite(projectRoot).assertAsync();
  }

  let tsconfig: null | TsConfigPaths = null;

  if (isTsconfigPathsEnabled) {
    Log.warn(
      chalk.yellow`Experimental path aliases feature is enabled. ` +
        learnMore('https://docs.expo.dev/guides/typescript/#path-aliases')
    );
    tsconfig = await loadTsConfigPathsAsync(projectRoot);
  }

  await setupNodeExternals(projectRoot);

  return withMetroMultiPlatform(projectRoot, {
    config,
    platformBundlers,
    tsconfig,
    isTsconfigPathsEnabled,
  });
}

function withMetroMultiPlatform(
  projectRoot: string,
  {
    config,
    platformBundlers,
    isTsconfigPathsEnabled,
    tsconfig,
  }: {
    config: ConfigT;
    isTsconfigPathsEnabled: boolean;
    platformBundlers: PlatformBundlers;
    tsconfig: TsConfigPaths | null;
  }
) {
  let expoConfigPlatforms = Object.entries(platformBundlers)
    .filter(([, bundler]) => bundler === 'metro')
    .map(([platform]) => platform);

  if (Array.isArray(config.resolver.platforms)) {
    expoConfigPlatforms = [...new Set(expoConfigPlatforms.concat(config.resolver.platforms))];
  }

  // @ts-expect-error: typed as `readonly`.
  config.resolver.platforms = expoConfigPlatforms;

  if (expoConfigPlatforms.includes('web')) {
    config = withWebPolyfills(config, projectRoot);
  }

  return withExtendedResolver(config, {
    projectRoot,
    tsconfig,
    isTsconfigPathsEnabled,
    platforms: expoConfigPlatforms,
  });
}
