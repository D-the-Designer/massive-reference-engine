import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const dist = new URL("../dist/", import.meta.url);
const assets = new URL("../dist/assets/", import.meta.url);
const server = new URL("../dist/server/", import.meta.url);

await rm(dist, { recursive: true, force: true });
await mkdir(assets, { recursive: true });
await mkdir(server, { recursive: true });

for (const name of ["index.html", "app.js", "styles.css"]) {
  await cp(new URL(`../${name}`, import.meta.url), new URL(`../dist/assets/${name}`, import.meta.url));
}
await mkdir(new URL("../dist/assets/assets/", import.meta.url), { recursive: true });
for (const name of ["writer-logo.png", "writer-social.jpg"]) {
  await cp(new URL(`../assets/${name}`, import.meta.url), new URL(`../dist/assets/assets/${name}`, import.meta.url));
}

const worker = `const SECURITY_HEADERS = {
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "SAMEORIGIN",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()"
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/writer" || url.pathname === "/writer/" || url.pathname === "/writer/index.html") {
      url.pathname = "/index.html";
      request = new Request(url, request);
    }

    let response = await env.ASSETS.fetch(request);
    if (response.status === 404 && !url.pathname.includes(".")) {
      url.pathname = "/index.html";
      response = await env.ASSETS.fetch(new Request(url, request));
    }

    const headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
    if (url.pathname === "/index.html" || url.pathname === "/") {
      headers.set("Cache-Control", "no-cache");
    } else if (response.ok) {
      headers.set("Cache-Control", "public, max-age=3600");
    }
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
};
`;

await writeFile(join(server.pathname, "index.js"), worker);
