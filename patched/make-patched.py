"""Copies tauri-plugin-http 2.8.3 from the cargo registry to patched/tauri-plugin-http
and applies the leak fix to its injected `api-iife.js`.

    python3 patched/make-patched.py
    # then add to src-tauri/Cargo.toml and build with a separate CARGO_TARGET_DIR:
    # [patch.crates-io]
    # tauri-plugin-http = { path = "../patched/tauri-plugin-http" }
"""
import glob, os, shutil

here = os.path.dirname(os.path.abspath(__file__))
src = glob.glob(os.path.expanduser('~/.cargo/registry/src/*/tauri-plugin-http-2.8.3'))[0]
dst = os.path.join(here, 'tauri-plugin-http')
shutil.rmtree(dst, ignore_errors=True)
shutil.copytree(src, dst)
for f in ('.cargo-ok', '.cargo_vcs_info.json'):
    if os.path.exists(os.path.join(dst, f)):
        os.remove(os.path.join(dst, f))

path = os.path.join(dst, 'api-iife.js')
s = open(path).read()

PATCHES = (
    'Object.defineProperty(A,"url",{value:b,writable:!1}),Object.defineProperty(A,"headers",{value:new Headers(g),writable:!1});'
    'const P=A.clone.bind(A);return Object.defineProperty(A,"clone",{value:()=>{const e=P();return Object.defineProperty(e,"url",'
    '{value:b,writable:!1}),Object.defineProperty(e,"headers",{value:new Headers(g),writable:!1}),e}}),A'
)
EDITS = [
    # 1. Module-level helpers: patch the Response outside `fetch`'s scope, and
    #    release the Rust response when the stream's source is garbage-collected.
    ('const r="Request cancelled";',
     'const r="Request cancelled",__drop=new FinalizationRegistry(e=>{e()});'
     'function __patch(A,b,g){' + PATCHES + '}'),
    # 2. Keep the underlying source object, to register it.
    ('let T=!1;', 'let S,T=!1;'),
    ('null:new ReadableStream({start:', 'null:new ReadableStream(S={start:'),
    # 3. Null-body status: release now. Otherwise release when the source is collected.
    (',A=new Response(R,{status:y,statusText:p});',
     ';R===null?m():__drop.register(S,m);const A=new Response(R,{status:y,statusText:p});'),
    # 4. No `A.clone.bind(A)` in the scope that the stream's closures share.
    (PATCHES + '},e}', 'return __patch(A,b,g)},e}'),
]
for old, new in EDITS:
    assert s.count(old) == 1, old
    s = s.replace(old, new)
open(path, 'w').write(s)
print('patched', path)
