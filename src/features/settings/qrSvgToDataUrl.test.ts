/**
 * The authenticator QR came out as a broken-image icon because the data URL said
 * `;utf-8` where RFC 2397 requires `attribute=value` — so the media type was
 * malformed and the browser refused to load it. The secret beside it was fine,
 * which is what made the fault look like "the QR is not generated".
 *
 * These assert the shape of the URL rather than that an image renders: the
 * malformed form is a string bug and a string test catches it.
 */
import { describe, expect, it } from "vitest";
import { qrSvgToDataUrl } from "./api/security.api";

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>';

describe("qrSvgToDataUrl", () => {
  it("declares the charset as a parameter, not a bare token", () => {
    const url = qrSvgToDataUrl(SVG);
    expect(url.startsWith("data:image/svg+xml;charset=utf-8,")).toBe(true);
    // The regression: `;utf-8,` with no `charset=` is what broke the dialog.
    expect(url).not.toContain(";utf-8,");
  });

  it("percent-encodes the markup so the payload survives an img src", () => {
    const url = qrSvgToDataUrl(SVG);
    expect(url).not.toContain("<svg");
    expect(url).toContain("%3Csvg");
    expect(decodeURIComponent(url.slice(url.indexOf(",") + 1))).toBe(SVG);
  });

  it("passes an already-encoded data URL through untouched", () => {
    const already = "data:image/png;base64,iVBORw0KGgo=";
    expect(qrSvgToDataUrl(already)).toBe(already);
  });

  it("returns empty for nothing usable, so the caller can omit the image", () => {
    expect(qrSvgToDataUrl("")).toBe("");
    expect(qrSvgToDataUrl("   ")).toBe("");
    // A server that answers with an otpauth URI or an error string must not be
    // wrapped in a data: URL and shown as a picture.
    expect(qrSvgToDataUrl("otpauth://totp/Tamarind?secret=ABC")).toBe("");
    expect(qrSvgToDataUrl("something went wrong")).toBe("");
  });

  it("accepts an SVG that opens with an XML declaration", () => {
    const withDecl = `<?xml version="1.0"?>${SVG}`;
    expect(qrSvgToDataUrl(withDecl)).toContain("charset=utf-8,%3C%3Fxml");
  });
});
