# Privacy policy

*Draft for legal review. Effective [Effective date].*

This policy explains how CHD Labs ("we") processes personal data when you
visit our website or use Tandem, a service that turns requests into tested
code changes with GitHub Copilot.

## 1. Who is responsible

CHD Labs ([legal form]), [Address], registered under [Registration number].
Privacy questions: privacy@chdlabs.com. Data protection officer: [DPO, or "not
required"].

For data that a business customer puts into its Tandem workspace (tasks, code,
conversations), the customer is the controller and we process it on their
behalf under our [data processing agreement](dpa.md). This policy covers what
we decide ourselves: accounts, the website, security and billing.

## 2. What we process, why, and on which legal basis

| Data | Purpose | Legal basis (GDPR) | Kept for |
| --- | --- | --- | --- |
| GitHub account data: login, name, email, avatar, account id | Sign you in, show who did what in a workspace | Art. 6(1)(b) contract | As long as your account exists |
| Workspace content you or your team create: requests, specs, approvals, conversations, check results, pull request links, audit log | Provide Tandem | Art. 6(1)(b) contract; for customer workspaces we act as processor | Until deleted by the workspace; audit log 1 year by default |
| Source code of repositories you connect | Build and check the changes you ask for | Art. 6(1)(b) contract | Only during a task on a hosted runner; not received at all with a company runner |
| Tokens for GitHub and AWS connections | Reach your repositories and Copilot on your behalf | Art. 6(1)(b) contract | Until you disconnect; encrypted |
| Security and service logs: IP address, user agent, request times, errors | Keep Tandem secure and working, investigate abuse | Art. 6(1)(f) legitimate interest | 30 days |
| Messages you send us | Answer you | Art. 6(1)(b) or (f) | Up to 2 years after the conversation ends |

We do not sell personal data, use it for advertising, or train AI models on
your content.

## 3. Copilot and AI processing

Tandem sends your requests, specs and the relevant code to GitHub Copilot
using **your own GitHub account and Copilot plan**. GitHub and the model
providers it uses process this under your agreement with GitHub; see GitHub's
privacy statement and Copilot terms. If your organisation uses GitHub
Enterprise Cloud with EU data residency, Copilot processing stays in the EU.

## 4. Who receives data

Our [subprocessors](subprocessors.md) (hosting in the EU, email delivery,
error monitoring), GitHub (sign-in, repositories, Copilot) and AWS (only if you
connect CodeCommit). Authorities only where the law requires it.

## 5. Transfers outside the EU

Tandem's own storage and processing are in the EU. Data reaches the United
States when you use GitHub and Copilot, which happens under your relationship
with GitHub; GitHub is certified under the EU-US Data Privacy Framework and
offers Standard Contractual Clauses. Any subprocessor outside the EU is listed
with its safeguard.

## 6. Cookies

We use one strictly necessary cookie to keep you signed in and protect against
cross-site request forgery. No analytics, advertising or tracking cookies, so
we do not ask for cookie consent. If this ever changes, we will ask first.

## 7. Your rights

You can access, export, correct and delete your data, restrict or object to
processing, and withdraw consent where processing relies on it. Most of this is
self-service in Settings › Privacy (export, delete account). Otherwise write to
privacy@chdlabs.com; we answer within one month. You may complain to a
supervisory authority, for example [Supervisory authority].

## 8. Security

Encryption in transit and at rest, per-workspace encryption keys, isolated
sandboxes per task, least-privilege access for our staff with multi-factor
authentication, and a tamper-evident audit log. We notify the authority within
72 hours of becoming aware of a personal data breach where required, and
affected customers without undue delay.

## 9. Children

Tandem is for professional use and not directed at children under 16.

## 10. Changes

We announce material changes in the app and by email at least 30 days ahead.
