/**
 * "6 need your attention" — the count, the red bar, the popup, and the rail badge.
 *
 * ── WHAT WAS ACTUALLY MISSING ────────────────────────────────────────────────
 * The rail's badge machinery has existed since the shell was written: `NavItem.badge`,
 * `NavRow`'s `<Badge>`, a `BadgeCounts` type. It was fed
 *
 *     const counts = useMemo<BadgeCounts>(() => ({}), []);
 *
 * so no row has ever rendered a count. Nothing was broken; nothing was connected.
 *
 * ── WHY THIS DOES NOT COUNT NOTIFICATIONS ────────────────────────────────────
 * Measured live on 5 Sep 2026: Suraj Kumar 17,890 unread in-app rows, Vinod Maurya 8,997,
 * Preethi Machani 8,250 — and 39,572 of all unread rows are `KIOSK_OFFLINE`. A popup built on
 * that number tells the busiest administrator "17,890 notifications", which is why nobody was
 * reading the feed in the first place. The attention surfaces count QUEUES THAT WAIT ON A
 * PERSON instead: three approvals, seven tickets, three captures. Small, true, and each opens
 * the screen that clears it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  headlineKey,
  popupItems,
  summariseAttention,
  POPUP_ROWS,
  type AttentionSource,
} from "./attention";

const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), "utf8");
/*
  LINE COMMENTS GO FIRST, and that ordering is load-bearing.

  `nav-model.ts` contains line comments that themselves contain a block-comment OPENER.
  Removing block comments first makes the non-greedy regex open there and close at the next
  terminator fifty lines below, swallowing the workflow nav row — so an assertion about that
  row failed against a file that plainly contained it. The file has 22 openers and 19
  terminators for exactly this reason.
*/
const strip = (s: string) =>
  s
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

const banner = strip(read("src", "features", "admin", "components", "AttentionBanner.tsx"));
const popup = strip(read("src", "features", "admin", "components", "AttentionPopup.tsx"));
const shell = strip(read("src", "app", "shell", "AppShell.tsx"));
const badges = strip(read("src", "app", "shell", "useNavBadges.ts"));
const navModel = strip(read("src", "app", "shell", "nav-model.ts"));
const cc = strip(read("src", "features", "admin", "pages", "CommandCentre.page.tsx"));
const api = strip(read("src", "features", "admin", "api", "command.api.ts"));

const at = (key: string, count: number | null): AttentionSource =>
  ({ key, count, href: `/x/${key}` }) as AttentionSource;

describe("the number in the sentence", () => {
  it("headlines the work that is BLOCKED, not the backlog behind it", () => {
    /* The live shape on 5 Sep 2026: one approval, seven tickets, thirty-one people yet to
       come to the camera. "39 need your action" would be dominated by a queue nobody is
       waiting on; one thing actually needs a decision. */
    const s = summariseAttention([at("approvals", 1), at("helpdesk", 7), at("faceAsks", 31)]);
    expect(s.actionCount).toBe(1);
    expect(s.followUpCount).toBe(38);
    expect(s.headline).toBe(1);
    expect(s.items).toHaveLength(3);
  });

  it("still lists the follow-up rows — nothing is hidden to keep the number small", () => {
    const s = summariseAttention([at("approvals", 1), at("faceAsks", 31)]);
    expect(s.items.map((i) => i.key)).toEqual(["approvals", "faceAsks"]);
  });

  it("headlines the follow-up count when nothing is blocked", () => {
    const s = summariseAttention([at("helpdesk", 7), at("faceAsks", 31)]);
    expect(s.urgent).toBe(false);
    expect(s.actionCount).toBe(0);
    expect(s.headline).toBe(38);
    expect(headlineKey(s)).toBe("admin.attention.followUpTitle");
  });

  it("uses the singular wording for exactly one", () => {
    expect(headlineKey(summariseAttention([at("approvals", 1)]))).toBe("admin.attention.titleOne");
    expect(headlineKey(summariseAttention([at("helpdesk", 1)])))
      .toBe("admin.attention.followUpTitleOne");
    expect(headlineKey(summariseAttention([at("approvals", 2)]))).toBe("admin.attention.title");
  });

  it("drops a queue with nothing in it", () => {
    const s = summariseAttention([at("approvals", 3), at("alerts", 0)]);
    expect(s.items.map((i) => i.key)).toEqual(["approvals"]);
    expect(s.actionCount).toBe(3);
  });

  it("treats a FAILED count as unknown, never as zero", () => {
    const s = summariseAttention([at("approvals", null), at("helpdesk", 2)]);
    expect(s.items.map((i) => i.key)).toEqual(["helpdesk"]);
    expect(s.followUpCount).toBe(2);
    expect(s.actionCount).toBe(0);
  });

  it("never counts a row the banner does not show", () => {
    /*
      A source whose key is missing from `ORDER` renders nothing. The total must ignore it
      too — a sentence promising six things above a list of three sends somebody hunting for
      a fourth that was never there. This is the shape the next queue added here will take if
      whoever adds it forgets the ORDER line, so the invariant is worth holding directly.
    */
    const s = summariseAttention([at("approvals", 3), at("somethingNew", 99)]);
    expect(s.items.map((i) => i.key)).toEqual(["approvals"]);
    expect(s.actionCount).toBe(3);
    expect(s.headline).toBe(3);
  });

  it("is empty when everything is clear", () => {
    const s = summariseAttention([at("approvals", 0), at("alerts", 0)]);
    expect(s.items).toHaveLength(0);
    expect(s.headline).toBe(0);
    expect(s.actionCount).toBe(0);
    expect(s.followUpCount).toBe(0);
    expect(s.urgent).toBe(false);
  });
});

describe("the order is by who is blocked, not by size", () => {
  it("puts 3 approvals above 31 face asks", () => {
    const s = summariseAttention([at("faceAsks", 31), at("approvals", 3)]);
    expect(s.items.map((i) => i.key)).toEqual(["approvals", "faceAsks"]);
  });

  it("keeps the fixed order whatever order the sources arrive in", () => {
    const keys = ["documents", "helpdesk", "punchReview", "alerts", "approvals"] as const;
    const s = summariseAttention(keys.map((k) => at(k, 1)));
    expect(s.items.map((i) => i.key)).toEqual([
      "approvals", "alerts", "punchReview", "helpdesk", "documents",
    ]);
  });
});

describe("red is earned", () => {
  it("is urgent when something is blocked on this administrator", () => {
    expect(summariseAttention([at("approvals", 1)]).urgent).toBe(true);
    expect(summariseAttention([at("punchReview", 1)]).urgent).toBe(true);
    expect(summariseAttention([at("faceCaptures", 1)]).urgent).toBe(true);
  });

  it("is NOT urgent for chasing and housekeeping alone", () => {
    expect(summariseAttention([at("faceAsks", 31), at("documents", 9)]).urgent).toBe(false);
    expect(summariseAttention([at("helpdesk", 7)]).urgent).toBe(false);
  });

  it("drives the banner's colour off `urgent`, not off having any items", () => {
    expect(banner).toContain("attention.urgent");
    // Both surfaces word the headline through one helper, so they cannot disagree.
    expect(banner).toContain("headlineKey(attention)");
    expect(popup).toContain("headlineKey(attention)");
    expect(banner).toContain("border-destructive/50 bg-destructive/5");
    expect(banner).toContain("border-warning/50 bg-warning/5");
  });
});

describe("the popup is short and loses nothing when closed", () => {
  it("shows at most three rows and counts the rest", () => {
    const s = summariseAttention(
      ["approvals", "alerts", "punchReview", "helpdesk", "faceAsks"].map((k) => at(k, 2)),
    );
    const { shown, more } = popupItems(s);
    expect(shown).toHaveLength(POPUP_ROWS);
    expect(more).toBe(2);
  });

  it("says nothing about 'more' when everything fits", () => {
    const { shown, more } = popupItems(summariseAttention([at("approvals", 1)]));
    expect(shown).toHaveLength(1);
    expect(more).toBe(0);
  });

  it("remembers the dismissal per signed-in user, in session storage", () => {
    expect(popup).toContain("sessionStorage");
    expect(popup).toContain("tt_attention_seen:");
    expect(popup).toContain("${SEEN_PREFIX}${userId}");
  });

  it("survives a browser that refuses session storage", () => {
    // Both accessors wrapped: a private window must not take the render down with it.
    expect(popup.match(/try \{/g) ?? []).toHaveLength(2);
    expect(popup).toContain("catch");
  });

  it("tells the reader the fact is still available after closing", () => {
    expect(popup).toContain("admin.attention.stillThere");
  });

  it("renders for administrators only, and gates the queries behind that", () => {
    expect(popup).toContain('caps.has("admin.access")');
    // The gate is a component boundary so the seven counts are never issued for an employee.
    expect(popup).toContain("AttentionPopupInner");
  });
});

describe("it is actually mounted", () => {
  it("puts the banner FIRST on the Command Centre, above the calendar", () => {
    expect(cc).toContain("<AttentionBanner");
    const bannerAt = cc.indexOf("<AttentionBanner");
    const calendarAt = cc.indexOf("<LeaveCalendarBand");
    const kpiAt = cc.indexOf("<CommandKpiStrip");
    expect(bannerAt).toBeGreaterThan(-1);
    expect(bannerAt).toBeLessThan(calendarAt);
    expect(bannerAt).toBeLessThan(kpiAt);
  });

  it("mounts the popup in the shell, so it finds an admin on any landing page", () => {
    expect(shell).toContain("<AttentionPopup />");
  });
});

describe("the rail badge that never rendered", () => {
  it("no longer feeds the badges an empty object", () => {
    expect(shell).toContain("const counts = useNavBadges();");
    expect(shell).not.toContain("useMemo<BadgeCounts>(() => ({}), [])");
  });

  it("gives the workflow inbox its OWN key, not the alert count", () => {
    expect(navModel).toContain('"admin.approvals"');
    const workflow = navModel.slice(navModel.indexOf("shell.nav.admin.workflow"));
    expect(workflow.slice(0, 200)).toContain('badge: "admin.approvals"');
  });

  it("counts pending approvals for that badge", () => {
    expect(badges).toContain("countMyAdminTasks");
    expect(badges).toContain('out["admin.approvals"]');
  });

  it("issues no admin counts for a reader without admin access", () => {
    expect(badges).toContain('const isAdmin = caps.has("admin.access")');
    expect(badges.match(/enabled: isAdmin,/g) ?? []).toHaveLength(2);
  });

  it("shares the Command Centre's query keys so nothing is counted twice", () => {
    expect(badges).toContain("qk.admin.approvalInboxCount()");
    expect(badges).toContain('qk.admin.exceptions({ agg: "count" })');
  });

  it("shows no badge for a pending or failed count", () => {
    expect(badges).toContain("q.isSuccess && q.data !== undefined && q.data > 0");
  });
});

describe("every count is the server's, over the destination's own predicate", () => {
  it("counts the face queues by status rather than fetching rows", () => {
    expect(api).toContain("countFaceAsksAwaitingEmployee");
    expect(api).toContain("countFaceCapturesAwaitingApproval");
    expect(api).toContain('FACE_ASK_OPEN_STATUS = "draft"');
    expect(api).toContain('FACE_CAPTURE_PENDING_STATUS = "pending"');
  });

  it("keeps the ask and the capture as separate lines", () => {
    // One is chased, the other is decided; merging them hides which is being asked for.
    const s = summariseAttention([at("faceAsks", 31), at("faceCaptures", 3)]);
    expect(s.items.map((i) => i.key)).toEqual(["faceCaptures", "faceAsks"]);
    expect(s.items[0]?.tone).toBe("act");
    expect(s.items[1]?.tone).toBe("chase");
  });

  it("counts open help tickets with a HEAD count", () => {
    expect(api).toContain("countOpenHelpdeskTickets");
    expect(api).toContain('HELPDESK_OPEN_STATUS = "open"');
    expect(api).toContain("selectCount(HELPDESK_TICKETS_TABLE");
  });
});
