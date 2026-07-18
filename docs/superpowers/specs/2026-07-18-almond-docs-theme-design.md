# Almond docs theme design

## Context

Rewind's Mintlify documentation currently uses the Maple theme. A browser comparison of Maple and Almond covered the welcome page, the Reading domain guide, and the split-pane API reference at a 1280 × 720 viewport.

Stock Almond produced a compact reading measure, clearer selected-navigation states, and a more cohesive page frame. The earlier Almond layout issue was associated with a custom `#content-area` width override that is no longer present.

## Decision

Change `docs-mintlify/docs.json` from the `maple` theme to the stock `almond` theme.

Do not add theme-specific CSS or change documentation content, colors, navigation, logos, or API-reference configuration.

## Release approach

The implementation commit will contain the approved theme change and this design record only. Existing unrelated working-tree changes will remain untouched.

The change will be based on the current remote `main` branch. After local validation, it will be pushed to GitHub through the repository's normal integration path. Mintlify's GitHub App will rebuild the hosted documentation from the updated production branch.

If the repository does not permit a direct production-branch push, use a focused pull request and merge it after required checks pass.

## Validation

Before publishing:

- Run Mintlify configuration validation.
- Run the broken-link check.
- Confirm the committed diff contains only the theme value and this design record.
- Confirm the Almond welcome, Reading guide, and API-reference layouts render without clipping or horizontal page overflow.

After publishing:

- Confirm the production deployment completes.
- Confirm `docs.rewind.rest` serves the Almond shell on a representative guide and API-reference page.

## Failure handling

Do not push or merge if local validation fails. If the hosted deployment fails, inspect the deployment result, correct only the release-blocking issue, rerun validation, and republish.

## Out of scope

- Custom width or typography overrides
- Documentation content rewrites
- Navigation restructuring
- Changes to the Astro landing site or Cloudflare Workers
