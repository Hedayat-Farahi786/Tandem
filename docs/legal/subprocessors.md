# Subprocessors

*Draft for legal review. Last updated [Effective date].*

Third parties that process personal data on [Operator]'s behalf to run
Tandem. We give workspace owners 30 days' notice of a new subprocessor, during
which they may object (see the [DPA](dpa.md)).

| Subprocessor | Service | Data | Location | Safeguard |
| --- | --- | --- | --- | --- |
| Amazon Web Services EMEA SARL | Hosting: compute, database, storage, encryption keys, hosted runners | All Tandem data | EU: Frankfurt (eu-central-1), backups in the EU | AWS GDPR DPA; data stays in the EU |
| [Email provider, EU region] | Sign-up and notification emails | Name, email address | EU | DPA |
| [Error monitoring, EU region] | Error reports with personal data removed where possible | Account id, technical data | EU | DPA |

**Not subprocessors, used under your own agreements:** GitHub (sign-in,
repositories, Copilot, under your GitHub agreement; Copilot may involve
model providers such as Microsoft, OpenAI, Anthropic and Google as GitHub
describes) and AWS CodeCommit in your own AWS account.
