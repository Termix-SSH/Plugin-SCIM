# Contributing to SCIM Provisioning

## Development

```bash
npm run build      # build into dist/
npm run test       # run this plugin's tests
npm run typecheck  # type-check this plugin
npm run validate   # check manifest.json
npm run migrations # write migrations after changing src/backend/tables.ts
npm run format     # format the code with Prettier
```

The SCIM protocol parts (filters, PATCH, resource shapes) are in `src/backend/scim/` and have no Termix code in them. Tests in `tests/backend/scim.test.ts` replay the requests Entra ID and Okta send; add one when you fix a provider quirk.

## Docs

The docs for this plugin are in [docs/](docs/) and are published at https://docs.termix.site/plugins/scim. Settings, permissions, services, environment variables and the API reference are made from `manifest.json` and the `@openapi` comments in the code, so keep those up to date instead of writing them by hand. See [writing docs](https://docs.termix.site/develop/docs).
