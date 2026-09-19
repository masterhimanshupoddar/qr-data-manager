# QR Data Manager

A small, mobile-friendly website for scanning a plain-text QR code on one device and displaying a QR with an automatically refreshed time on another. TypeScript and Vite provide the static frontend, jsQR decodes images and camera frames, qrcode generates PNGs, and Supabase PostgreSQL stores the latest original text together with its actual scan instant. No running application server is required.

## What it does

1. Upload a JPG/JPEG, PNG, or WebP QR image, or scan with your camera.
2. When decoding succeeds, the app immediately captures the device's actual system time. It saves that instant and the unchanged decoded text together in Supabase. Confirm the successful save status before leaving.
3. Open the same deployed website on another device to load the original text and its saved scan time.
4. A live QR appears automatically. Its encoded time advances by the duration since that saved scan instant, rounded down to complete 15-second intervals.
5. Download the current QR as a PNG or copy its current text. **Refresh QR now** recalculates it immediately; the countdown shows the next scheduled refresh.

Only the generated QR changes as time passes. The original text, its saved scan instant, and the database's last-saved timestamp remain unchanged until another QR is scanned and saved. Scanning the same QR again intentionally starts a new scan baseline. Opening, refreshing, or switching devices never resets it.

## How the live time works

The original text must contain exactly one `YYYY-MM-DD HH:mm:ss` field, delimited by `#` or the beginning/end of the text. For example:

```text
B1008501Z2691616859851#2026-09-16 16:09:12# 1 x Filter Coffee#598
```

Suppose this QR is successfully decoded when the device clock reads `17:00:00`. When the current system time reaches `17:01:07`, the elapsed duration is 67 seconds. Rounding down to complete 15-second intervals gives 60 seconds. The generated QR adds those 60 seconds to the original encoded time `16:09:12`:

```text
B1008501Z2691616859851#2026-09-16 16:10:12# 1 x Filter Coffee#598
```

On each refresh the app calculates:

```text
elapsedMilliseconds = currentSystemInstant - savedScanInstant
appliedSeconds = floor(elapsedMilliseconds / 15000) * 15
generatedTime = originalEncodedTime + appliedSeconds, wrapping at 24 hours
```

For a scan captured at `17:00:00`, with an original encoded time of `16:09:12`:

| Current system time | Raw elapsed seconds | Applied seconds | Time in generated QR |
| --- | ---: | ---: | --- |
| Same day `17:00:14` | 14 | 0 | `16:09:12` |
| Same day `17:00:15` | 15 | 15 | `16:09:27` |
| Same day `17:01:07` | 67 | 60 | `16:10:12` |
| Next day `17:01:07` | 86,467 | 86,460 | `16:10:12` |

The examples assume no system clock or time-zone offset change during the interval. Actual elapsed time uses complete saved/current instants, including elapsed days. Only the resulting clock value wraps at 24 hours. The original date `2026-09-16` intentionally remains unchanged, even across midnight or after several days.

The QR's embedded date and time supply the original text and clock value to advance; they are not the real scan instant. They are not interpreted as a time-zone-specific baseline. An embedded future date is allowed. A saved `scanned_at` later than the current device instant produces a clock mismatch error until the current clock reaches that instant.

Capture happens at successful decoding, before any network save delay. A failed save retains that original capture instant for **Save again**; retrying does not replace it with the retry time. `updated_at` is a separate server save timestamp and is never substituted for the real scan instant. Use devices with accurate system clocks. The page displays time information in the device's local zone, while the saved scan instant includes its UTC offset; changing display zones does not redefine the captured instant.

Every refresh recomputes elapsed time from the saved capture and current clock. It does not repeatedly add 15 seconds, so timer delays do not accumulate. Browsers can delay timers in background tabs or while a device sleeps. Returning to the page recalculates the current interval. A downloaded PNG is a snapshot and does not update after download.

Identifiers, spaces, punctuation, newlines, and all original text outside `HH:mm:ss` are preserved exactly. Missing, invalid, or multiple timestamp fields produce a readable error instead of changing unrelated text. The original QR text can still be saved even if it cannot produce a live time QR. This is a text QR workflow; it does not promise lossless conversion of arbitrary binary QR payloads. The app does not append, trim, normalize, encrypt, or decrypt the contents.

Only the decoded original text and its capture instant are sent to Supabase. Image files, camera frames, and generated time updates stay in the browser. Uploaded images are limited to 20 MiB, 24 million pixels, and 16,384 pixels along either edge.

## 1. Set up or upgrade Supabase

**Existing installation:** open the project's **SQL Editor** and run the complete [`supabase/migrations/20260918_add_scanned_at.sql`](supabase/migrations/20260918_add_scanned_at.sql) file. This adds capture-time support without changing existing QR text or its server save timestamp. Existing records have `scanned_at = NULL`, because their actual capture time cannot be recovered. Rescan the original QR after applying the migration. The app does not invent a capture time from the QR timestamp, the previous save time, or the current clock. The migration is safe to rerun.

**New installation:**

1. Create a project on the [Supabase Free plan](https://supabase.com/pricing). Choose a region and complete the project's database setup. The database administration password is not an application password and does not belong in the frontend.
2. Open the project's **SQL Editor**, create a query, paste the full contents of [`supabase/schema.sql`](supabase/schema.sql), and run it.
3. In **Table Editor**, verify `public.qr_state` contains one row with `id = 1` and `qr_data`, `scanned_at`, and `updated_at` all NULL. These values mean no QR code has been saved yet. Rerunning the supplied SQL preserves existing values.
4. Open the project's **Connect** dialog and copy its project URL and **publishable** key (`sb_publishable_...`). Keys are also available under **Settings > API Keys**. A legacy `anon` key is supported, but prefer a publishable key for a new project. Never use a secret (`sb_secret_...`) or `service_role` key. See the [official API key guide](https://supabase.com/docs/guides/getting-started/api-keys).
5. Keep the project's Data API enabled and `public` exposed so the frontend can reach `qr_state`.

The SQL enables Row Level Security and grants the unauthenticated `anon` role SELECT plus UPDATE of only `qr_data` and `scanned_at`. Each new scan saves these two fields atomically. Browser clients have no INSERT or DELETE permission and cannot change `id` or `updated_at`. A server trigger sets `updated_at` on saves and rejects changed QR text that reuses the previous capture instant; retries with identical data and capture remain valid.

The primary key and `id = 1` constraint allow at most one row. Empty strings and values larger than 8,192 UTF-8 bytes are rejected; whitespace is preserved. New browser saves require a finite, non-NULL capture instant. The table permits legacy records with text and an unknown NULL capture, but forbids a capture instant without QR text. The 15-second live refresh does not write to the database. See [Supabase's grants and RLS documentation](https://supabase.com/docs/guides/database/postgres/row-level-security).

**This is intentionally a public shared record.** There is no authentication or application password. Anyone who can access the website or discover its public Supabase endpoint/key can read and overwrite the latest original QR text and capture instant. RLS limits the operations and row; it does not identify a trusted person. All users of this deployment share the same record, and the last successful save wins. Do not put confidential contents in this deployment. A public API key identifies the application; it is not a secret or an encryption key.

## 2. Configure and run locally

Install Node.js 22.12 or newer, open a terminal in this project folder, and run:

```sh
npm ci
```

For a new checkout, create `.env` with the two variables below and replace the placeholder URL and key. If `.env` already exists, retain its configuration and edit only the values you need to change. This capture-time upgrade does not require configuration changes.

```dotenv
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=sb_publishable_your_public_key
```

The variable name `VITE_SUPABASE_ANON_KEY` accepts either a publishable key or a legacy anon key. These values are compiled into the public frontend. `.env` is ignored by Git; private credentials must never be added to any `VITE_` variable. The build accepts only publishable or legacy anon keys and rejects private keys. A build with both Supabase values unset opens with a setup notice; it cannot save or retrieve cloud data until valid configuration is supplied and the app is rebuilt. Configuring only one of the two Supabase values fails the build.

```sh
npm run dev
```

Open the localhost address printed by Vite. After changing `.env`, restart the development server. No constant, separator, or source time-zone setting is required.

The included `package-lock.json` records the dependency versions used by `npm ci`.

To check and build the production bundle:

```sh
npx playwright install chromium
npm test
npm run build
npm run preview
```

`npm run build` creates `dist/`. The preview command serves this built bundle locally; it is not needed on Cloudflare. Automated browser checks use mocked cloud responses and do not write to your configured Supabase project.

## 3. Deploy to Cloudflare

### Cloudflare Workers (the existing deployment)

The included `wrangler.jsonc` publishes the built `dist/` directory as static assets. It tells Wrangler that this project is already configured, so `wrangler deploy` does not try to install a Vite plugin or rewrite `vite.config.ts`. See [Cloudflare's static assets configuration](https://developers.cloudflare.com/workers/static-assets/binding/) and [skipping automatic configuration](https://developers.cloudflare.com/workers/framework-guides/automatic-configuration/#skipping-automatic-configuration).

1. Commit and push `wrangler.jsonc` at the repository root, alongside `package.json` and `package-lock.json`.
2. In your Cloudflare Worker's build settings, use:

   | Setting | Value |
   | --- | --- |
   | Worker name | `qr-data-manager` (must match `name` in `wrangler.jsonc`) |
   | Root directory | Repository root, where `package.json` lives |
   | Build command | `npm run build` |
   | Deploy command | `npx wrangler deploy` |

3. Under **Settings > Build > Build Variables and Secrets**, add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` with the same URL and public key as your local `.env`. Worker runtime variables alone cannot configure this frontend; Vite embeds these values when the build runs. See [Cloudflare build settings](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/).
4. Trigger a new build from the commit containing `wrangler.jsonc`. A retry of an older commit will still lack the configuration. Open the deployed `workers.dev` address on both devices once deployment succeeds.

If the log says `Build command completed` followed by `Cannot modify Vite config: could not find a valid plugins array`, the app built successfully but Wrangler attempted automatic setup during deployment. Verify that the deployed commit includes `wrangler.jsonc` and that the build root is the directory containing it. No Vite configuration change is needed.

### Cloudflare Pages (alternative hosting setup)

1. Put this project folder in a GitHub or GitLab repository, including `package.json` and `package-lock.json`, and push it. Do not commit `.env` or `node_modules`.
2. In Cloudflare, open **Workers & Pages > Create application > Pages > Connect to Git** and select the repository. Follow the [official Git integration guide](https://developers.cloudflare.com/pages/get-started/git-integration/).
3. Select the production branch. Choose these build settings:

   | Setting | Value |
   | --- | --- |
   | Framework preset | Vite, or None with the settings below |
   | Build command | `npm run build` |
   | Build output directory | `dist` |
   | Root directory | Folder containing `package.json`; leave blank if at repository root |

   These commands follow Cloudflare's [Vite deployment guide](https://developers.cloudflare.com/pages/framework-guides/deploy-a-vite3-project/).
4. Add both `VITE_` variables listed above to the **Production** build environment. Set `NODE_VERSION` to `22.16.0` or a newer supported Node 22 release. Add corresponding **Preview** variables only if you want preview builds; scanning and saving from a preview that uses the production database also overwrites the production record. Environment variables are under the project's **Settings > Environment variables** after creation; see [build configuration](https://developers.cloudflare.com/pages/configuration/build-configuration/).
5. Select **Save and Deploy**. Open the resulting `https://your-project.pages.dev` address on both devices. A custom domain is optional.
6. When an environment variable changes, trigger a fresh deployment/build. Already published JavaScript cannot read new build settings. Future pushes deploy automatically.

For an existing deployment, apply the capture-time migration and deploy the updated frontend, then rescan the original QR. Merely redeploying the frontend cannot add a database column or recover a past capture instant.

The supplied `public/_headers` sets the site's Content Security Policy. Its `connect-src` allows standard Supabase project URLs under `https://*.supabase.co`. If you configure a custom Supabase API domain, add that exact HTTPS origin to `connect-src` in this file and redeploy.

This static site uses no Pages Functions or paid server. The current Pages Free plan includes 500 builds per month. Supabase Free includes a 500 MB database and may pause projects after one week of inactivity; resume a paused project in the dashboard before using the app again. Free service quotas and policies can change. Sources: [Cloudflare limits](https://developers.cloudflare.com/pages/platform/limits/) and [Supabase pricing](https://supabase.com/pricing), checked September 18, 2026.

## Verify the complete flow

Use a separate test Supabase project for checks that intentionally save sample text. Local automated tests do not establish that your deployed site can reach your live project.

1. On device A, scan a QR containing the complete sample above and wait for a successful cloud save. Note the actual system scan time.
2. Close the browser. Open the deployed URL on device B and verify both the unchanged original text and the same saved capture instant appear.
3. Confirm the live QR appears automatically. At 67 elapsed seconds it should show `16:10:12`, while the original date and all remaining text stay unchanged.
4. Check the scan/current times, raw elapsed duration, rounded applied seconds, and countdown. **Refresh QR now** must recalculate from the saved capture without modifying the original or cloud save time.
5. Copy the generated text and download the PNG. Scan the PNG with a separate QR reader to verify that snapshot's contents. Uploading it to this app intentionally creates a new original and a new capture instant.
6. Leave the page in the background and return. It should recompute elapsed time rather than replay missed updates.
7. Rescan the same original QR. Confirm the new capture instant resets elapsed time.
8. Test text without a timestamp, a picture without a QR, denied camera permission, and lost internet access. A failed save followed by **Save again** must retain the initial decoding instant.

For a database permissions check in a test project's Supabase SQL Editor, this transaction saves a sample text/capture pair as the browser role, then rolls back so it preserves the existing record:

```sql
begin;
set local role anon;
select id, qr_data, scanned_at, updated_at from public.qr_state;
update public.qr_state
set qr_data = 'Temporary permission check',
    scanned_at = clock_timestamp()
where id = 1
returning qr_data, scanned_at, updated_at;
rollback;
```

Run read-only privilege checks separately as the default SQL Editor role:

```sql
select
  has_table_privilege('anon', 'public.qr_state', 'SELECT') as can_read,
  has_column_privilege('anon', 'public.qr_state', 'qr_data', 'UPDATE') as can_write_text,
  has_column_privilege('anon', 'public.qr_state', 'scanned_at', 'UPDATE') as can_write_capture,
  has_column_privilege('anon', 'public.qr_state', 'id', 'UPDATE') as can_change_id,
  has_column_privilege('anon', 'public.qr_state', 'updated_at', 'UPDATE') as can_change_time,
  has_table_privilege('anon', 'public.qr_state', 'INSERT') as can_insert,
  has_table_privilege('anon', 'public.qr_state', 'DELETE') as can_delete;
```

Expected results: `true, true, true, false, false, false, false`.

## Troubleshooting and limits

- **Setup is incomplete:** verify the URL/key, rebuild after changing configuration, and run the full schema SQL for a new project.
- **Capture time missing or migration required:** apply `supabase/migrations/20260918_add_scanned_at.sql`, then rescan the original QR. Old records remain readable but cannot generate a live QR without a known actual capture time.
- **Cloud save/load fails:** check internet access, a paused Supabase project, Data API settings, table permissions, and RLS policies. An on-screen decoded value is not saved until the save succeeds.
- **No previous data:** scan and successfully save a QR on any device first. A fresh database starts empty.
- **No QR detected:** use a sharp, well-lit image with the entire QR and white border visible. Supported uploads are JPG/JPEG, PNG, and WebP. If an image exceeds 20 MiB, 24 million pixels, or 16,384 pixels on either edge, export a smaller image with the QR still clearly legible.
- **No live QR:** the original must contain exactly one valid `YYYY-MM-DD HH:mm:ss` field bounded by `#` or the text edges, and have a saved capture instant.
- **Clock mismatch:** the current system instant is before the saved actual scan instant. Check the scanning and viewing devices' clocks. The QR's embedded date does not cause this error, even when that date is in the future.
- **Camera unavailable:** use HTTPS (the Pages URL) or localhost, allow browser camera permission, and close other apps using the camera. Phone access to an HTTP development server over the local network generally cannot use the camera; upload an image instead.
- **Copy unavailable:** allow clipboard access and use HTTPS, or select and copy the displayed generated text manually.
- **QR generation fails:** the generated text may exceed QR capacity. Large Unicode payloads can hit this limit sooner. The database limit does not guarantee that every saved text fits a generated QR.
- **Downloaded QR stops changing:** downloaded PNGs are fixed snapshots. Keep the website open for the live QR or download a new snapshot when needed.

The app stores one original/capture pair with no history, queue, or offline synchronization. It loads the latest cloud record when opened and checks for changes every 30 seconds, when the window regains focus, or when you refresh the saved data manually. These cloud reads are separate from the live QR's 15-second refresh and never change the capture instant. Automatic cloud refresh pauses while decoded data is awaiting a successful save, so it does not replace that pending text and capture. PostgreSQL text cannot store the NUL character (`U+0000`); the app rejects it before saving. Transport uses HTTPS, but QR contents remain plain text throughout the application.
