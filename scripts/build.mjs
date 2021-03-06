/*
Copyright 2020 Bruno Windels <bruno@windels.cloud>
Copyright 2020 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import cheerio from "cheerio";
import fsRoot from "fs";
const fs = fsRoot.promises;
import path from "path";
import xxhash from 'xxhashjs';
import { rollup } from 'rollup';
import postcss from "postcss";
import postcssImport from "postcss-import";
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import commander from "commander";
// needed for legacy bundle
import babel from '@rollup/plugin-babel';
// needed to find the polyfill modules in the main-legacy.js bundle
import { nodeResolve } from '@rollup/plugin-node-resolve';
// needed because some of the polyfills are written as commonjs modules
import commonjs from '@rollup/plugin-commonjs';
// multi-entry plugin so we can add polyfill file to main
import multi from '@rollup/plugin-multi-entry';
import removeJsComments from 'rollup-plugin-cleanup';
// replace urls of asset names with content hashed version
import postcssUrl from "postcss-url";

import cssvariables from "postcss-css-variables";
import flexbugsFixes from "postcss-flexbugs-fixes";

const PROJECT_ID = "hydrogen";
const PROJECT_SHORT_NAME = "Hydrogen";
const PROJECT_NAME = "Hydrogen Chat";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectDir = path.join(__dirname, "../");
const cssSrcDir = path.join(projectDir, "src/ui/web/css/");
const targetDir = path.join(projectDir, "target/");

const program = new commander.Command();
program
    .option("--no-offline", "make a build without a service worker or appcache manifest")
program.parse(process.argv);
const {debug, noOffline} = program;
const offline = !noOffline;

const olmFiles = {
    wasm: "olm-4289088762.wasm",
    legacyBundle: "olm_legacy-3232457086.js",
    wasmBundle: "olm-1421970081.js",
};

// IDEA: how about instead of assetPaths we maintain a mapping between the source file and the target file
// so throughout the build script we can refer to files by their source name

async function build() {
    // only used for CSS for now, using legacy for all targets for now
    const legacy = true;
    // get version number
    const version = JSON.parse(await fs.readFile(path.join(projectDir, "package.json"), "utf8")).version;

    const devHtml = await fs.readFile(path.join(projectDir, "index.html"), "utf8");
    const doc = cheerio.load(devHtml);
    const themes = [];
    findThemes(doc, themeName => {
        themes.push(themeName);
    });
    // clear target dir
    await removeDirIfExists(targetDir);
    await createDirs(targetDir, themes);
    // copy assets
    await copyFolder(path.join(projectDir, "lib/olm/"), targetDir);
    // also creates the directories where the theme css bundles are placed in,
    // so do it first
    const themeAssets = await copyThemeAssets(themes, legacy);
    const jsBundlePath = await buildJs("src/main.js", `${PROJECT_ID}.js`);
    const jsLegacyBundlePath = await buildJsLegacy("src/main.js", `${PROJECT_ID}-legacy.js`, 'src/legacy-extras.js');
    const jsWorkerPath = await buildWorkerJsLegacy("src/worker.js", `worker.js`);
    const cssBundlePaths = await buildCssBundles(legacy ? buildCssLegacy : buildCss, themes, themeAssets);

    let manifestPath;

    const assetPaths = createAssetPaths(jsBundlePath, jsLegacyBundlePath, jsWorkerPath,
        cssBundlePaths, themeAssets);

    if (offline) {
        manifestPath = await buildOffline(version, assetPaths);
    }
    await buildHtml(doc, version, assetPaths, manifestPath);

    console.log(`built ${PROJECT_ID} ${version} successfully`);
}

function trim(path) {
    if (!path.startsWith(targetDir)) {
        throw new Error("invalid target path: " + targetDir);
    }
    return path.substr(targetDir.length);
}

function createAssetPaths(jsBundlePath, jsLegacyBundlePath, jsWorkerPath, cssBundlePaths, themeAssets) {
    return {
        jsBundle: () => trim(jsBundlePath),
        jsLegacyBundle: () => trim(jsLegacyBundlePath),
        jsWorker: () => trim(jsWorkerPath),
        cssMainBundle: () => trim(cssBundlePaths.main),
        cssThemeBundle: themeName => trim(cssBundlePaths.themes[themeName]),
        cssThemeBundles: () => Object.values(cssBundlePaths.themes).map(a => trim(a)),
        otherAssets: () => Object.values(themeAssets).map(a => trim(a)),
    };
}

async function findThemes(doc, callback) {
    doc("link[rel~=stylesheet][title]").each((i, el) => {
        const theme = doc(el);
        const href = theme.attr("href");
        const themesPrefix = "/themes/";
        const prefixIdx = href.indexOf(themesPrefix);
        if (prefixIdx !== -1) {
            const themeNameStart = prefixIdx + themesPrefix.length;
            const themeNameEnd = href.indexOf("/", themeNameStart);
            const themeName = href.substr(themeNameStart, themeNameEnd - themeNameStart);
            callback(themeName, theme);
        }
    });
}

async function createDirs(targetDir, themes) {
    await fs.mkdir(targetDir);
    const themeDir = path.join(targetDir, "themes");
    await fs.mkdir(themeDir);
    for (const theme of themes) {
        await fs.mkdir(path.join(themeDir, theme));
    }
}

async function copyThemeAssets(themes, legacy) {
    const assets = {};
    for (const theme of themes) {
        const themeDstFolder = path.join(targetDir, `themes/${theme}`);
        const themeSrcFolder = path.join(cssSrcDir, `themes/${theme}`);
        const themeAssets = await copyFolder(themeSrcFolder, themeDstFolder, file => {
            const isUnneededFont = legacy ? file.endsWith(".woff2") : file.endsWith(".woff");
            return !file.endsWith(".css") && !isUnneededFont;
        });
        Object.assign(assets, themeAssets);
    }
    return assets;
}

async function buildHtml(doc, version, assetPaths, manifestPath) {
    // transform html file
    // change path to main.css to css bundle
    doc("link[rel=stylesheet]:not([title])").attr("href", assetPaths.cssMainBundle());
    // change paths to all theme stylesheets
    findThemes(doc, (themeName, theme) => {
        theme.attr("href", assetPaths.cssThemeBundle(themeName));
    });
    const pathsJSON = JSON.stringify({
        worker: assetPaths.jsWorker(),
        olm: olmFiles
    });
    doc("script#main").replaceWith(
        `<script type="module">import {main} from "./${assetPaths.jsBundle()}"; main(document.body, ${pathsJSON});</script>` +
        `<script type="text/javascript" nomodule src="${assetPaths.jsLegacyBundle()}"></script>` +
        `<script type="text/javascript" nomodule>${PROJECT_ID}Bundle.main(document.body, ${pathsJSON}, ${PROJECT_ID}Bundle.legacyExtras);</script>`);
    removeOrEnableScript(doc("script#service-worker"), offline);

    const versionScript = doc("script#version");
    versionScript.attr("type", "text/javascript");
    let vSource = versionScript.contents().text();
    vSource = vSource.replace(`"%%VERSION%%"`, `"${version}"`);
    versionScript.text(vSource);

    if (offline) {
        doc("html").attr("manifest", "manifest.appcache");
        doc("head").append(`<link rel="manifest" href="${manifestPath.substr(targetDir.length)}">`);
    }
    await fs.writeFile(path.join(targetDir, "index.html"), doc.html(), "utf8");
}

async function buildJs(inputFile, outputName) {
    // create js bundle
    const bundle = await rollup({
        input: inputFile,
        plugins: [removeJsComments({comments: "none"})]
    });
    const {output} = await bundle.generate({
        format: 'es',
        // TODO: can remove this?
        name: `${PROJECT_ID}Bundle`
    });
    const code = output[0].code;
    const bundlePath = resource(outputName, code);
    await fs.writeFile(bundlePath, code, "utf8");
    return bundlePath;
}

async function buildJsLegacy(inputFile, outputName, extraFile, polyfillFile) {
    // compile down to whatever IE 11 needs
    const babelPlugin = babel.babel({
        babelHelpers: 'bundled',
        exclude: 'node_modules/**',
        presets: [
            [
                "@babel/preset-env",
                {
                    useBuiltIns: "entry",
                    corejs: "3",
                    targets: "IE 11",
                    // we provide our own promise polyfill (es6-promise)
                    // with support for synchronous flushing of
                    // the queue for idb where needed 
                    exclude: ["es.promise", "es.promise.all-settled", "es.promise.finally"]
                }
            ]
        ]
    });
    if (!polyfillFile) {
        polyfillFile = 'src/legacy-polyfill.js';
    }
    const inputFiles = [polyfillFile, inputFile];
    if (extraFile) {
        inputFiles.push(extraFile);
    }
    // create js bundle
    const rollupConfig = {
        input: inputFiles,
        plugins: [multi(), commonjs(), nodeResolve(), babelPlugin]
    };
    const bundle = await rollup(rollupConfig);
    const {output} = await bundle.generate({
        format: 'iife',
        name: `${PROJECT_ID}Bundle`
    });
    const code = output[0].code;
    const bundlePath = resource(outputName, code);
    await fs.writeFile(bundlePath, code, "utf8");
    return bundlePath;
}

function buildWorkerJsLegacy(inputFile, outputName) {
    const polyfillFile = 'src/worker-polyfill.js';
    return buildJsLegacy(inputFile, outputName, null, polyfillFile);
}

async function buildOffline(version, assetPaths) {
    // write web manifest
    const webManifest = JSON.parse(await fs.readFile(path.join(projectDir, "assets/manifest.json"), "utf8"));
    for (const icon of webManifest.icons) {
        let iconData = await fs.readFile(path.join(projectDir, icon.src));
        let iconPath = resource(path.basename(icon.src), iconData);
        await fs.writeFile(iconPath, iconData);
        icon.src = trim(iconPath);
    }
    // write offline availability
    const offlineFiles = [
        assetPaths.cssMainBundle(),
        "index.html",
    ].concat(assetPaths.cssThemeBundles())
    .concat(webManifest.icons.map(i => i.src));

    // write appcache manifest
    const appCacheLines = [
        `CACHE MANIFEST`,
        `# v${version}`,
        `NETWORK`,
        `"*"`,
        `CACHE`,
    ];
    appCacheLines.push(assetPaths.jsLegacyBundle(), ...offlineFiles);
    const swOfflineFiles = [assetPaths.jsBundle(), ...offlineFiles];
    const appCacheManifest = appCacheLines.join("\n") + "\n";
    await fs.writeFile(path.join(targetDir, "manifest.appcache"), appCacheManifest, "utf8");
    // write service worker
    let swSource = await fs.readFile(path.join(projectDir, "src/service-worker.template.js"), "utf8");
    swSource = swSource.replace(`"%%VERSION%%"`, `"${version}"`);
    swSource = swSource.replace(`"%%OFFLINE_FILES%%"`, JSON.stringify(swOfflineFiles));
    swSource = swSource.replace(`"%%CACHE_FILES%%"`, JSON.stringify(assetPaths.otherAssets()));
    await fs.writeFile(path.join(targetDir, "sw.js"), swSource, "utf8");
    const manifestJson = JSON.stringify(webManifest);
    const manifestPath = resource("manifest.json", manifestJson);
    await fs.writeFile(manifestPath, manifestJson, "utf8");
    return manifestPath;
}

async function buildCssBundles(buildFn, themes, themeAssets) {
    const bundleCss = await buildFn(path.join(cssSrcDir, "main.css"));
    const mainDstPath = resource(`${PROJECT_ID}.css`, bundleCss);
    await fs.writeFile(mainDstPath, bundleCss, "utf8");
    const bundlePaths = {main: mainDstPath, themes: {}};
    for (const theme of themes) {
        const urlBase = path.join(targetDir, `themes/${theme}/`);
        const assetUrlMapper = ({absolutePath}) => {
            const hashedDstPath = themeAssets[absolutePath];
            if (hashedDstPath && hashedDstPath.startsWith(urlBase)) {
                return hashedDstPath.substr(urlBase.length);
            }
        };
        const themeCss = await buildFn(path.join(cssSrcDir, `themes/${theme}/theme.css`), assetUrlMapper);
        const themeDstPath = resource(`themes/${theme}/bundle.css`, themeCss);
        await fs.writeFile(themeDstPath, themeCss, "utf8");
        bundlePaths.themes[theme] = themeDstPath;
    }
    return bundlePaths;
}

async function buildCss(entryPath, urlMapper = null) {
    const preCss = await fs.readFile(entryPath, "utf8");
    const options = [postcssImport];
    if (urlMapper) {
        options.push(postcssUrl({url: urlMapper}));
    }
    const cssBundler = postcss(options);
    const result = await cssBundler.process(preCss, {from: entryPath});
    return result.css;
}

async function buildCssLegacy(entryPath, urlMapper = null) {
    const preCss = await fs.readFile(entryPath, "utf8");
    const options = [
        postcssImport,
        cssvariables(),
        flexbugsFixes()
    ];
    if (urlMapper) {
        options.push(postcssUrl({url: urlMapper}));
    }
    const cssBundler = postcss(options);
    const result = await cssBundler.process(preCss, {from: entryPath});
    return result.css;
}

function removeOrEnableScript(scriptNode, enable) {
    if (enable) {
        scriptNode.attr("type", "text/javascript");
    } else {
        scriptNode.remove();
    }
}

async function removeDirIfExists(targetDir) {
    try {
        await fs.rmdir(targetDir, {recursive: true});
    } catch (err) {
        if (err.code !== "ENOENT") {
            throw err;
        }
    }
}

async function copyFolder(srcRoot, dstRoot, filter) {
    const assetPaths = {};
    const dirEnts = await fs.readdir(srcRoot, {withFileTypes: true});
    for (const dirEnt of dirEnts) {
        const dstPath = path.join(dstRoot, dirEnt.name);
        const srcPath = path.join(srcRoot, dirEnt.name);
        if (dirEnt.isDirectory()) {
            await fs.mkdir(dstPath);
            Object.assign(assetPaths, await copyFolder(srcPath, dstPath, filter));
        } else if ((dirEnt.isFile() || dirEnt.isSymbolicLink()) && (!filter || filter(srcPath))) {
            const content = await fs.readFile(srcPath);
            const hashedDstPath = resource(dstPath, content);
            await fs.writeFile(hashedDstPath, content);
            assetPaths[srcPath] = hashedDstPath;
        }
    }
    return assetPaths;
}

function resource(relPath, content) {
    let fullPath = relPath;
    if (!path.isAbsolute(relPath)) {
        fullPath = path.join(targetDir, relPath);
    }
    const hash = contentHash(Buffer.from(content));
    const dir = path.dirname(fullPath);
    const extname = path.extname(fullPath);
    const basename = path.basename(fullPath, extname);
    return path.join(dir, `${basename}-${hash}${extname}`);
}

function contentHash(str) {
    var hasher = new xxhash.h32(0);
    hasher.update(str);
    return hasher.digest();
}


build().catch(err => console.error(err));
