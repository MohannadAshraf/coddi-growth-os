# Attribution capture — founder action required

**Deadline: before 2026-09-20.** This is the only non-retroactive item in the
project. Click IDs not captured on launch day cannot be reconstructed later, by
any dashboard. Source spec: `coddiwomple-data-architecture.md` §3.

## Why Claude Code could not ship this

Both halves are blocked by connector permissions, not by missing work:

| Half | Blocker |
|---|---|
| Theme snippet | The Shopify connector allows theme file writes **on unpublished themes only**. The theme needing it is `gid://shopify/OnlineStoreTheme/100000000004` ("Copy of Pdp videos draft"), role **MAIN** — the live theme. Writes to it are blocked. |
| Ad URL parameters | `url_tags` is not a supported field on the Meta Ads connector at ad, adset, campaign or account level. It cannot be read or written. |

Both need to be done by hand in the admin UIs. Everything else is ready.

## Step 1 — theme snippet

Shopify admin → Online Store → Themes → **Edit code** on the live theme →
`layout/theme.liquid` → paste the `<script>` block from
`attribution/theme-snippet.liquid` **immediately before `</head>`** → Save.

Cleaner alternative: save that file as `snippets/cw-attribution.liquid`, then add
one line before `</head>`:

```liquid
{%- render 'cw-attribution' -%}
```

## Step 2 — ad account URL parameters

Meta Ads Manager → Ad account settings, or per-ad **URL parameters** field.
Paste exactly:

```
utm_source=meta&utm_medium=paid&utm_campaign={{campaign.id}}&utm_content={{ad.id}}&utm_term={{adset.id}}
```

`utm_content={{ad.id}}` is the load-bearing part — it is what joins an order back
to a specific ad. `fbclid` is appended by Meta automatically; do not add it.

**Use `{{campaign.id}}`, not `{{campaign.name}}`** (corrected 2026-09-09):

1. A campaign name is free text and can contain `&`, `=` or `#`. Any of those
   inside a query string can truncate or corrupt everything after it — including
   `utm_content`, the one parameter that actually matters.
2. The pipeline never needs the name here. `resolveOrderAttribution`
   (`worker.js:6153`) joins on `utm_content` = ad id, and treats `utm_campaign`
   only as a coarse fallback tier. Campaign names already arrive from the Meta
   API sync in `MetaCampaignWeekly`, so a name in the URL is a lookup we already
   have.
3. Names get edited. Ids do not. A renamed campaign silently splits its own
   history; an id never does.

### "Values previously set" — the warning Meta shows

Meta warns that some ads carry their own URL parameters. **Ad-level parameters
take precedence over the account-level default**, so publishing the account-level
value will not overwrite them, and those ads will keep whatever they have.

Publish anyway — an account-level default is strictly better than nothing, and it
covers every ad that does not have its own. Then spot-check two or three active
ads' own **URL parameters** field. Any ad that has its own value needs
`utm_content={{ad.id}}` added there too, or its orders will never join to it.

The verification below reveals this without guesswork: if unattributed share falls
but plateaus well above zero, ad-level overrides are the reason.

### TikTok — REQUIRED, confirmed running 2026-09-09

TikTok ads are live: order #10036 carried `_cw_platform: tiktok`. Its campaign
arrived as a **name** (`sales 5/8`) with **no** `utm_content`, so those orders can
never join to a specific ad.

TikTok Ads Manager → the ad's tracking/destination URL → append:

```
utm_source=tiktok&utm_medium=paid&utm_campaign=__CAMPAIGN_ID__&utm_content=__CID__&utm_term=__AID__
```

`utm_content` must carry the **ad-level** id, the same role `{{ad.id}}` plays on
Meta. TikTok's macro names have moved between API versions and I have not verified
them against the current UI — **use the macro picker in TikTok Ads Manager if it
offers one**, and confirm with the test below that `_cw_content` arrives as a
number matching an ad id in the Ads Manager. If it arrives as a name, the macro is
wrong and the ad-level join will not work.

`_cw_platform` is set from `utm_source`, so `utm_source=tiktok` is what makes the
pipeline count these orders as a non-Meta channel — which is what drives
`paid_spend_basis` and stops MER and CAC quietly overstating efficiency.

## Step 3 — verify, same day

1. Open the store through an ad link (or append
   `?utm_source=meta&utm_content=TEST123&fbclid=TEST456` to any product URL).
2. Add to cart, then check `/cart.js` — `attributes` should carry `_cw_click_id`
   and `_cw_content`.
3. Place a test order. In the Shopify admin the order's **Additional details**
   should show `_cw_click_id` / `_cw_content`.
4. If step 2 is empty, the snippet is not firing — check it sits before `</head>`
   and that no consent banner blocks `localStorage`.

Do not wait until launch day to test this.

## Resolution order — for the pipeline side, once orders carry the data

1. `click_id` matched in the platform's click export → exact
2. `utm_content` matches a known `ad_id` → high confidence
3. `utm_campaign` only → campaign-level
4. Nothing → `unattributed`. **Never silently assign to last-click.**

Track unattributed share as a health metric. **Above ~25% means capture is
broken and every downstream number is suspect.**

## What this unlocks

- **Delivered CAC per ad** — contribution margin attributed to the ad that
  produced the order, net of that order's RTO. Platform ROAS counts a COD parcel
  that comes back as revenue; this does not.
- **Acquisition engine vs closer** — which ads bring customers who then buy
  something else entirely. Changes budget allocation and almost nobody tracks it.
