// Static server for the built site with SPA fallback. Used by the container image.
const dist = decodeURIComponent(new URL("./dist/", import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, "$1");
const index = Bun.file(`${dist}/index.html`);
const port = Number(process.env.PORT ?? 3000);
Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);
    let path = decodeURIComponent(url.pathname);
    if (path.includes("..")) return new Response("bad path", { status: 400 });
    const file = Bun.file(`${dist}${path}`);
    if (path !== "/" && (await file.exists())) {
      const immutable = path.startsWith("/assets/");
      return new Response(file, { headers: { "cache-control": immutable ? "public, max-age=31536000, immutable" : "public, max-age=300" } });
    }
    return new Response(index, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
  },
});
console.log(`site on :${port}`);
