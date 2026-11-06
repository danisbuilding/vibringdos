# Vibringdos

A Friendsgiving potluck sign-up app. A host writes down the dishes they need,
shares one link, and guests claim a dish, say what they're bringing, and leave a
note. No accounts, no sign-in, no app to install.

Standalone fork of [vibring](https://github.com/danisbuilding/vibring). The two
are independent — a change here does not reach vibring, and vice versa.

Live at **vibringdos.danisbuilding.cc**

## What's different from vibring

| | vibring | vibringdos |
|---|---|---|
| Vocabulary | volunteer, item | **chef, dish** |
| Count | "3 needed" | "3 needed" / "3 **more** needed" |
| Sign-up fields | name, qty, note | name, **dish, hot/cold, serves**, note, **private note to host** |
| List shows | name + note | name + **dish** + "Hot · Serves 8 · note" |
| Host gets | — | **a collated "Notes for you" block** with copy-all |
| Colour | fixed forest green | **nine themes**, picked per event |
| Top of the page | title block | optional **header photo** above it |

## Layout

```
public/index.html          the whole frontend: router, views, styles
public/fonts/              self-hosted Recursive variable woff2
public/_redirects          /h/* and /e/* -> index.html
public/_headers            CSP and security headers
functions/api/[[path]].js  the whole API, one onRequest handler
functions/img/[[path]].js  serves header photos out of R2, outside /api
schema.sql                 D1 and R2 shapes
tests/api.test.mjs         41 integration tests
```

No framework, no bundler, no dependencies.

## Tests

```
node --test tests/api.test.mjs
```

Needs Node 22+ (`node:sqlite`). No network, no wrangler, no database — the suite
shims D1 over in-memory SQLite and applies the real `schema.sql`, and shims R2
over a `Map`.

## Header photos

Optional, one per gathering, and absent from the DOM entirely when unset — the
page then starts with the title exactly as it did before.

The editor normalises every photo to **1200x600 JPEG** on a canvas before it
leaves the browser, so a stored banner is always the same shape and the page can
reserve its box with `aspect-ratio` instead of jumping when the bytes land. A
photo taller than 2:1 gets a drag control to choose which band survives the
crop; centre-cropping a portrait is otherwise a coin flip on whether faces make
it. Sources under 1000x500 are refused rather than upscaled into a soft banner.

The server does not trust any of that. It re-sniffs the JPEG magic bytes (never
the content-type header, which the caller sets), re-checks the 2 MB cap, and
requires the host key. Uploads count against the host write throttle.

Objects live in R2 under the same string the `events.header_image` column
stores, minus the leading slash. Replacing a photo deletes the object it
replaced; deleting a gathering deletes its object. Keys carry a random token, so
any stored image is immutable and `/img/` serves it with a year-long immutable
cache. `/img/` is a separate Function precisely so that the `Cache-Control:
no-store` rule `_headers` puts on `/api/*` does not reach it.

Because images are served from the app's own origin, `img-src 'self'` in the CSP
already covers them. Nothing in `_headers` needed to open up.

## The one rule that matters

`claims.note_to_host` is a **host-only** column. It is excluded from the `SELECT`
in every guest-facing response, not merely left unrendered by the client. The
guest payload is unauthenticated and returns the full claim set, so a column
that ships in the JSON is readable by anyone with the guest link and a dev-tools
panel.

Three tests guard this. If you touch `loadItems`, keep the audience split.

"Host-only" means whoever holds the host URL. There is no password.

## Themes

Nine, in `THEMES` at the top of the script. Each is sixteen derived tokens, not
hand-picked colours — deep tier at L\*16 C\*24, with burnt orange the one
mid-tier theme at L\*40 C\*68. All clear WCAG AA on every checked pair.

Don't hand-edit a single value; regenerate the set so the relationships hold.
Event pages take the host's theme; the landing page and dashboard always stay
forest so the app keeps an identity of its own.

## Deploying

Cloudflare Pages, connected to this repo. Framework preset **None**, build
command **empty**, build output directory **`public`**. D1 database bound as
**`DB`**, R2 bucket bound as **`IMG`**.

Without the R2 binding everything still works and photo uploads return a clear
503 — the feature is additive, not load-bearing.

`functions/` sits at the repo root, beside `public/` — not inside it. Pages only
compiles Functions from a Git-connected project; a dashboard folder upload ships
static files only and the API silently 404s.

Schema changes go in the D1 console one statement at a time — the console
flattens a multi-line paste onto one line, which turns `--` comments into a
comment that swallows the rest.

## Deployment record

| | |
|---|---|
| Pages project | `vibringdos` |
| Repo | `danisbuilding/vibringdos`, branch `main` |
| Build output directory | `public` |
| Build command | none |
| D1 database | `vibringdos`, bound as `DB` |
| R2 bucket | `vibringdos-images`, bound as `IMG` |
| Domains | `vibringdos.danisbuilding.cc`, `vibringdos.pages.dev` |

Health check: `/api/health` returns `db_bound` and `db_query`. Both must be
`true`. A binding added after a deployment does not reach it — redeploy, or push
a commit, so a new deployment picks it up.
