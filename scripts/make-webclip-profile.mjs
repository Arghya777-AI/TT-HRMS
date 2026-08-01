/**
 * Generates `public/tt-hrms.mobileconfig` — an iOS Configuration Profile carrying a Web Clip.
 *
 * ── WHAT THIS IS FOR ─────────────────────────────────────────────────────────
 * iPhone has no install API: a web page cannot install itself and Safari reserves "Add to Home
 * Screen" to the Share menu. A Web Clip profile is the ONE mechanism Apple provides by which
 * tapping a link on a page ends with an app icon on the home screen. The person taps Download,
 * iOS downloads the profile, and installing it adds a full-screen icon that launches this app
 * with no address bar — the same result as Add to Home Screen, reached by downloading a file.
 *
 * ── WHY IT IS GENERATED AND NOT HAND-WRITTEN ─────────────────────────────────
 * The icon has to be embedded in the plist as base64 PNG bytes, so the file is ~60 KB of
 * base64 that no one should be editing by hand, and the target URL changes with the deployment
 * host. Both come from here. Re-run it when the icon or the production domain changes:
 *
 *   node scripts/make-webclip-profile.mjs [siteUrl]
 *
 * ── THE UUIDs ARE FIXED, DELIBERATELY ────────────────────────────────────────
 * iOS identifies a profile by `PayloadIdentifier` + `PayloadUUID`. Fresh UUIDs on every build
 * would make each deploy look like a DIFFERENT profile, so a phone would accumulate duplicate
 * icons instead of updating the one it has. They are constants for that reason — do not
 * randomise them.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const SITE_URL = process.argv[2] ?? "https://tt-hrms.vercel.app";

/** Stable identity — see the header. Regenerating these would duplicate icons on every phone. */
const PROFILE_UUID = "6F3B1C2A-8E44-4B1D-9C77-2A5E0D8B4F10";
const WEBCLIP_UUID = "B21D7A5E-4C90-4E63-A0F2-7D3C9E51A882";
const PROFILE_ID = "in.machanigroup.tamarindtree.hrms.webclip";

const root = path.resolve(import.meta.dirname, "..");
// 180×180 is the size iOS asks for a home-screen icon; `Precomposed` tells it not to add its
// own gloss and rounding on top of a mark that already has them.
const iconPath = path.join(root, "public", "pwa", "apple-touch-icon.png");
const icon = await readFile(iconPath);
const iconBase64 = icon.toString("base64");

/** Base64 wrapped at 60 columns, which is how Apple's own tooling emits `<data>` blocks. */
const wrapped = (iconBase64.match(/.{1,60}/g) ?? []).join("\n\t\t\t");

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>PayloadContent</key>
	<array>
		<dict>
			<key>PayloadType</key>
			<string>com.apple.webClip.managed</string>
			<key>PayloadIdentifier</key>
			<string>${PROFILE_ID}.clip</string>
			<key>PayloadUUID</key>
			<string>${WEBCLIP_UUID}</string>
			<key>PayloadVersion</key>
			<integer>1</integer>
			<key>PayloadDisplayName</key>
			<string>TT HRMS</string>
			<key>PayloadDescription</key>
			<string>Adds the Tamarind Tree HRMS icon to your home screen.</string>
			<key>Label</key>
			<string>TT HRMS</string>
			<key>URL</key>
			<string>${SITE_URL}/me?source=webclip</string>
			<!-- Opens without Safari's address bar and toolbar: the point of the exercise. -->
			<key>FullScreen</key>
			<true/>
			<!-- The icon already has its own shape; iOS must not add gloss and rounding again. -->
			<key>Precomposed</key>
			<true/>
			<!-- The employee can delete the icon like any app. Locking it down would be hostile. -->
			<key>IsRemovable</key>
			<true/>
			<key>Icon</key>
			<data>
			${wrapped}
			</data>
		</dict>
	</array>
	<key>PayloadType</key>
	<string>Configuration</string>
	<key>PayloadIdentifier</key>
	<string>${PROFILE_ID}</string>
	<key>PayloadUUID</key>
	<string>${PROFILE_UUID}</string>
	<key>PayloadVersion</key>
	<integer>1</integer>
	<key>PayloadDisplayName</key>
	<string>Tamarind Tree HRMS</string>
	<key>PayloadDescription</key>
	<string>Adds the TT HRMS app icon to your iPhone home screen. It contains nothing else — no VPN, no certificates, no device management, and no access to anything on your phone. You can remove it at any time from Settings.</string>
	<key>PayloadOrganization</key>
	<string>Machani Hospitalities LLP</string>
	<key>PayloadRemovalDisallowed</key>
	<false/>
</dict>
</plist>
`;

const out = path.join(root, "public", "tt-hrms.mobileconfig");
await writeFile(out, plist, "utf8");
console.log(`wrote ${path.relative(root, out)} — ${(plist.length / 1024).toFixed(1)} KB, url ${SITE_URL}`);
