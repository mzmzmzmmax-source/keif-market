# ZarinPal trust badge — integration note

## Current decision

The store footer already contains the official Enamad trust seal. A ZarinPal trust badge must only be shown when the ZarinPal account dashboard supplies the current, account-specific trust code or official embed instructions and the merchant account is approved.

## Important constraints

- Do not use a copied third-party badge image as proof of an approved merchant account.
- Do not construct a trust-page URL or embed code from an unverified tutorial.
- Do not show a badge that implies the Kif Market gateway is approved while the application is still pending/rejected.
- Keep the live footer unchanged until the account holder obtains the official badge code from the ZarinPal panel.
- Once the account is approved, place the exact ZarinPal-provided code in the footer beside the Enamad seal, preserving the existing cream/brown/gold design and responsive layout.
- Test that the badge loads, opens the official ZarinPal verification page, and identifies the correct registered domain.

## Current state

No badge code has been added to `index.html`. This is intentional: the public search results available during preparation included old third-party tutorials, not a current authoritative ZarinPal instruction. The exact embed should be copied from the account holder's authenticated ZarinPal panel or confirmed by ZarinPal support.
