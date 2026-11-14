// Guards the published file's tree-shaking. The library is shipped as one pre-bundled file, and a
// bundler can only drop its top-level work if that work is free of side effects. If someone adds a
// table built by plain calls at import time, small imports start dragging in every machine type.
import { build } from 'esbuild'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(__dirname, '..')

/** Bundle `code` against the library the way an app would: from a pre-bundled single file, minified. */
async function consumerBytes(code: string): Promise<number> {
  const prebuilt = (
    await build({
      entryPoints: [join(root, 'src/index.ts')],
      bundle: true,
      format: 'esm',
      write: false,
    })
  ).outputFiles[0].text
  const app = await build({
    stdin: { contents: code, resolveDir: root },
    plugins: [
      {
        name: 'ftms-js',
        setup(b) {
          b.onResolve({ filter: /^ftms-js$/ }, () => ({ path: 'ftms-js', namespace: 'lib' }))
          b.onLoad({ filter: /.*/, namespace: 'lib' }, () => ({ contents: prebuilt, loader: 'js' }))
        },
      },
    ],
    bundle: true,
    minify: true,
    format: 'esm',
    write: false,
  })
  return app.outputFiles[0].contents.length
}

describe('tree-shaking of the built library', () => {
  it('a tiny helper import does not pull in the machine schemas', async () => {
    // about 200 bytes today; it was about 3000 when the schema tables ran at import time
    expect(await consumerBytes("import { toHex } from 'ftms-js'; console.log(toHex)")).toBeLessThan(800)
  })

  it('a control-point parser does not pull in the machine schemas', async () => {
    // about 1.7 KB today; it was about 4.5 KB
    expect(
      await consumerBytes(
        "import { parseControlResponse } from 'ftms-js'; console.log(parseControlResponse)",
      ),
    ).toBeLessThan(2800)
  })
})
