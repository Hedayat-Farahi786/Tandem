# Legal documents (drafts)

> **Drafts, not legal advice.** These documents were written to match how
> Tandem works, as a starting point for the operator's lawyer. They must be
> reviewed, adapted to the operator's company and jurisdiction, and completed
> before Tandem is offered to the public.

| Document | Purpose | Shown where |
| --- | --- | --- |
| [privacy-policy.md](privacy-policy.md) | GDPR Art. 13/14 information for users and website visitors | Website footer, sign-up, Settings › Privacy |
| [terms-of-service.md](terms-of-service.md) | The contract for using Tandem | Sign-up (accepted), website footer |
| [dpa.md](dpa.md) | Data processing agreement (GDPR Art. 28) for business customers | Accepted by workspace owners in the app; downloadable |
| [subprocessors.md](subprocessors.md) | Who processes data on Tandem's behalf, where, and why | Website, linked from the DPA |
| [records-of-processing.md](records-of-processing.md) | Record of processing activities (GDPR Art. 30), internal | Kept by the operator |

Operator: **CHD Labs** (chdlabs.com). Tandem's own domain is not chosen
yet: `[domain]` and `[privacy email]` stand for it.
Placeholders still to fill in: `[legal form]`,
`[Address]`, `[Registration number]`, `[VAT ID]`, `[privacy email]`
(email), `[DPO]` (if one is required), `[Supervisory authority]`,
`[Governing law and courts]`, `[Effective date]`.

Facts these drafts rely on (keep them true, or update the drafts):

* Tandem's own processing and storage happen in the EU (AWS eu-central-1,
  backups in the EU).
* Copilot is provided by GitHub under the user's own GitHub account; prompts
  and code sent to Copilot are processed by GitHub and its model providers.
* No advertising or tracking cookies; only a strictly necessary session cookie.
* Source code is processed by a hosted runner only during a task and deleted
  afterwards; with a company runner, Tandem's cloud does not receive it.
