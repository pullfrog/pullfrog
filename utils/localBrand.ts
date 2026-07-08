/**
 * Weltel / full-local branding for PR comment + review footers.
 *
 * SaaS footer links (Fix it, Implement plan, Rerun) hit pullfrog.com/trigger/...
 * which does nothing useful without the hosted dashboard. When local mode is
 * on, we render Weltel chrome and comment-based / Actions deep links instead.
 *
 * Enable via workflow env:
 *   PULLFROG_LOCAL=1
 *   PULLFROG_BRAND=weltel          # optional label (default when LOCAL=1)
 *   PULLFROG_HOME_URL=...          # optional brand link (default: org/repo of action)
 *   PULLFROG_TRIGGER_WORKFLOW=pullfrog.yml  # workflow file for "Run agent" link
 */

export type LocalBrand = {
  local: boolean;
  brandName: string;
  homeUrl: string;
  triggerWorkflow: string;
};

export function resolveLocalBrand(): LocalBrand {
  const local =
    process.env.PULLFROG_LOCAL === "1" ||
    process.env.PULLFROG_LOCAL === "true" ||
    process.env.PULLFROG_BRAND?.toLowerCase() === "weltel";

  const brandName =
    process.env.PULLFROG_BRAND?.trim() ||
    (local ? "Weltel" : "Pullfrog");

  const homeUrl =
    process.env.PULLFROG_HOME_URL?.trim() ||
    (local
      ? "https://github.com/Weltel-repo/weltel-pullfrog"
      : "https://pullfrog.com");

  const triggerWorkflow =
    process.env.PULLFROG_TRIGGER_WORKFLOW?.trim() || "pullfrog.yml";

  return { local, brandName, homeUrl, triggerWorkflow };
}

export function isLocalPullfrog(): boolean {
  return resolveLocalBrand().local;
}

/** Markdown logo + brand for the footer lead-in */
export function brandLeadHtml(brand: LocalBrand): string {
  if (!brand.local) {
    // SaaS frog logo (unchanged)
    return `<a href="https://pullfrog.com"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pullfrog.com/logos/frog-white-full-18px.png"><img src="https://pullfrog.com/logos/frog-green-full-18px.png" width="9px" height="9px" style="vertical-align: middle; " alt="Pullfrog"></picture></a>`;
  }
  // Text brand — no external SaaS assets
  return `<a href="${brand.homeUrl}"><b>${escapeHtml(brand.brandName)}</b></a>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function brandAttribution(brand: LocalBrand): string {
  if (!brand.local) {
    return "via [Pullfrog](https://pullfrog.com)";
  }
  return `via [${brand.brandName} · local](${brand.homeUrl})`;
}

export function brandSocialLink(brand: LocalBrand): string | null {
  if (brand.local) {
    // No Pullfrog X promo in local installs
    return process.env.PULLFROG_SOCIAL_URL
      ? `[↗](${process.env.PULLFROG_SOCIAL_URL})`
      : null;
  }
  return "[𝕏](https://x.com/pullfrogai)";
}

/** Local substitutes for SaaS /trigger Fix buttons */
export function buildLocalFixParts(params: {
  owner: string;
  repo: string;
  pullNumber: number;
  reviewId: number;
  hasComments: boolean;
}): string[] {
  const brand = resolveLocalBrand();
  const prUrl = `https://github.com/${params.owner}/${params.repo}/pull/${params.pullNumber}`;
  const actionsUrl = `https://github.com/${params.owner}/${params.repo}/actions/workflows/${brand.triggerWorkflow}`;

  // GitHub cannot prefill PR comments via URL. Point at the PR and show the
  // @mention command (handled by pullfrog-triggers.yml). reviewId kept for
  // future local-dashboard deep links.
  void params.reviewId;
  if (params.hasComments) {
    return [
      `[Fix all](${prUrl}) · comment \`@pullfrog fix all\``,
      `[Fix 👍s](${prUrl}) · comment \`@pullfrog fix thumbs\``,
      `[Run agent](${actionsUrl})`,
    ];
  }
  return [
    `[Fix it](${prUrl}) · comment \`@pullfrog fix it\``,
    `[Run agent](${actionsUrl})`,
  ];
}


export function buildLocalImplementPlanPart(params: {
  owner: string;
  repo: string;
  issueNumber: number;
}): string {
  const brand = resolveLocalBrand();
  const issueUrl = `https://github.com/${params.owner}/${params.repo}/issues/${params.issueNumber}`;
  const actionsUrl = `https://github.com/${params.owner}/${params.repo}/actions/workflows/${brand.triggerWorkflow}`;
  return `[Implement plan](${issueUrl}) · comment \`${"@pullfrog implement plan"}\` · [Run agent](${actionsUrl})`;
}

export function buildLocalRerunPart(params: {
  owner: string;
  repo: string;
  runId: number;
}): string {
  const runUrl = `https://github.com/${params.owner}/${params.repo}/actions/runs/${params.runId}`;
  return `[Rerun / view run](${runUrl})`;
}
