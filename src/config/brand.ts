/**
 * Brand + employer-of-record constants. The trading brand is "The Tamarind Tree";
 * the legal employer is "Machani Hospitalities LLP" (NOT a hospital). Where both
 * must appear, use `combined`.
 *
 * Hex values here are for contexts that cannot read CSS variables (jsPDF exports,
 * canvas, <meta theme-color>). In the DOM, always use the Tailwind/CSS tokens.
 */
export const BRAND = {
  tradingName: "The Tamarind Tree",
  legalName: "Machani Hospitalities LLP",
  llpin: "AAF-9371",
  combined: "The Tamarind Tree · A unit of Machani Hospitalities LLP",
  tagline: "A heritage venue in Bengaluru",
  venueAddress:
    "88, Avalahalli, Anjanapura Post, JP Nagar 9th Phase, Kanakapura Road, Bengaluru, Karnataka 560108",
  registeredOffice:
    "Plot No. 04, Bommasandra Industrial Area, Anekal Taluk, Bengaluru, Karnataka 560099",
  email: "hello@tamarindtree.co",
  website: "https://www.thetamarindtree.in/",
  timezone: "Asia/Kolkata",
  palette: {
    terracotta: "#CE8F6F",
    gold: "#B99665",
    plum: "#564147",
    navy: "#121F38",
    cream: "#F6F0E9",
  },
} as const;

export type Brand = typeof BRAND;
