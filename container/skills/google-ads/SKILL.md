---
name: google-ads
description: Manage Google Ads campaigns and view GA4 analytics via AdLoop MCP tools.
---

# Google Ads & GA4 (AdLoop)

You have access to Google Ads campaign management and GA4 analytics via `mcp__adloop__*` tools.

## Multi-account

### Google Ads
The system is connected to a Manager Account (MCC) with multiple client accounts.
- Always use `list_accessible_customers` first to show available accounts
- Ask the user which account/client to operate on before making changes
- Include the account name in confirmations so the user knows where changes apply

### GA4 Analytics
One OAuth grants access to all GA4 accounts and properties the user has permissions for.
- Use `get_account_summaries()` to discover all available accounts and properties
- All GA4 tools accept an optional `property_id` parameter to query any property
- If omitted, the default property from config is used
- When the user has multiple sites, always clarify which property to analyze

## Safety workflow

AdLoop enforces a "draft -> preview -> confirm" pattern:
1. New campaigns always start **PAUSED**
2. Preview all changes before applying
3. Use `dry_run=true` for budget modifications
4. **Never** enable campaigns or increase budgets without explicit user confirmation

## Core mission

Your primary goal with Google Ads is **optimization**: spend less, get more qualified traffic that converts. Every analysis should lead to actionable recommendations.

## Campaign optimization & insights

When the user asks to analyze campaigns or improve performance, follow this framework:

### 1. Diagnose — pull data across dimensions
- Campaign/ad group/keyword performance (impressions, clicks, CTR, CPC, conversions, CPA, ROAS)
- GA4 cross-reference: which ad clicks actually lead to sessions that convert? Which don't?
- Search term report: what queries are actually triggering ads? Find irrelevant ones bleeding budget
- Device/geo/time breakdown: where is money wasted vs. where it converts best?
- Quality Score analysis: which keywords have low QS dragging up CPC?

### 2. Identify waste — find where budget leaks
- Keywords with high spend but zero/low conversions — candidates for pause or negative keywords
- Search terms that don't match intent — add as negative keywords
- Ad groups with below-average CTR — ad copy needs refresh
- Devices/geos/hours with high CPA — reduce bids or exclude
- Broad match keywords eating budget on irrelevant queries — tighten match types

### 3. Find growth — spot what works and scale it
- Keywords/ads with strong conversion rate but low impression share — increase budget/bids
- Top-converting search terms not yet as explicit keywords — add them
- High-CTR ad copy patterns — replicate across other ad groups
- Best-performing geos/times — shift budget toward them
- Landing pages with best conversion rates — use them more broadly

### 4. Recommend — present clear actions with expected impact
Format every insight as:
- **What**: the finding (with numbers)
- **Why it matters**: impact on cost or conversions
- **Action**: specific change to make
- **Expected result**: estimated savings or conversion lift

Always quantify: "Pausing these 12 keywords saves ~$X/day while losing only Y clicks that weren't converting anyway."

### 5. Execute (with confirmation)
After user approves recommendations:
- Apply changes via draft -> preview -> confirm workflow
- Group related changes together (e.g. all negative keywords in one batch)
- Schedule a follow-up check: "Let's review impact in 3-5 days"

## Common tasks

### Campaign management
- Create campaigns (always paused), add ad groups, keywords, ads
- Preview full structure before enabling
- Show cost estimates and daily budget impact

### Performance monitoring
- Use GA4 cross-referencing: ad clicks -> sessions -> conversions
- Present metrics clearly with period-over-period comparison
- Always include: spend, conversions, CPA, ROAS, impression share

### Budget changes
- Show current spend vs. budget before any modification
- Use dry-run mode first
- Confirm with user before applying

## Rules
- Never enable campaigns or increase budgets without explicit user confirmation
- Always present costs in the user's currency
- When operating on a client account, state which account clearly
- If credentials are missing or expired, tell the user to re-run `adloop init` on the server
- Every report should end with actionable next steps, not just numbers
- Compare to previous period by default (last 7d vs prior 7d) so trends are visible
