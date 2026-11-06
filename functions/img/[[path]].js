// Header images, served from /img/ rather than /api/ so that the API's
// `Cache-Control: no-store` rule in public/_headers does not apply to them.
// Object keys carry a random token, so any stored image is immutable: replacing
// one writes a new key and the old URL is simply never referenced again. That is
// what makes the year-long immutable cache safe.
//
// Bind the R2 bucket to the name "IMG" in the Pages project settings.

export async function onRequest({ request, env, params }) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405 });
  }

  // Only the exact shape this app writes is served. Anything else is a 404
  // rather than a lookup, so the bucket cannot be walked through this route.
  const segs = (params.path || []).filter(Boolean);
  if (
    segs.length !== 2 ||
    !/^[a-f0-9]{1,32}$/.test(segs[0]) ||
    !/^[a-z0-9]{1,32}\.jpg$/.test(segs[1])
  ) {
    return new Response("Not found", { status: 404 });
  }

  if (!env.IMG) return new Response("Image storage not configured", { status: 503 });

  const object = await env.IMG.get(`img/${segs[0]}/${segs[1]}`);
  if (!object) return new Response("Not found", { status: 404 });

  return new Response(object.body, {
    headers: {
      "content-type": "image/jpeg",
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
      etag: object.httpEtag,
    },
  });
}
