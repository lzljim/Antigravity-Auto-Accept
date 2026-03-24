// @ts-check
const esbuild = require('esbuild');
const { copyFileSync, existsSync } = require('fs');
const { join } = require('path');

const production = process.argv.includes('--production');

async function main() {
    // ─── Entry 1: Extension (CJS) ───
    const extCtx = await esbuild.context({
        entryPoints: ['src/extension.ts'],
        bundle: true,
        format: 'cjs',
        minify: production,
        sourcemap: !production,
        sourcesContent: false,
        platform: 'node',
        outfile: 'dist/extension.js',
        external: ['vscode'],
        logLevel: 'info',
        mainFields: ['module', 'main'],
    });

    // ─── Entry 2: MCP Server (ESM, 全打包) ───
    const mcpCtx = await esbuild.context({
        entryPoints: ['mcp/index.ts'],
        bundle: true,
        format: 'esm',
        minify: production,
        sourcemap: !production,
        sourcesContent: false,
        platform: 'node',
        outfile: 'dist/mcp-server.mjs',
        // MCP Server 独立运行，打包所有依赖（不 external）
        external: [],
        logLevel: 'info',
        mainFields: ['module', 'main'],
        banner: {
            // ESM 中 __dirname / __filename polyfill
            js: `import{fileURLToPath as __f}from'url';import{dirname as __d}from'path';const __filename=__f(import.meta.url);const __dirname=__d(__filename);`,
        },
    });

    // 复制 dashboard.html（MCP Dashboard 需要）
    const dashSrc = join(__dirname, 'mcp', 'modules', '..', '..', 'mcp', 'modules', '..', 'dashboard.html');
    // 尝试从已知位置复制
    const possibleSources = [
        join(__dirname, 'mcp', 'dashboard.html'),
        join(__dirname, '..', 'antigravity-local-mcp', 'src', 'dashboard.html'),
    ];
    for (const src of possibleSources) {
        if (existsSync(src)) {
            copyFileSync(src, join(__dirname, 'dist', 'dashboard.html'));
            console.log(`Copied dashboard.html from ${src}`);
            break;
        }
    }

    if (process.argv.includes('--watch')) {
        await extCtx.watch();
        await mcpCtx.watch();
        console.log('Watching for changes...');
    } else {
        await extCtx.rebuild();
        await mcpCtx.rebuild();
        await extCtx.dispose();
        await mcpCtx.dispose();
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
