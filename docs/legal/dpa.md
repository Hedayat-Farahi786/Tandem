# Data processing agreement

*Draft for legal review, under Article 28 GDPR. Effective [Effective date].*

Between the customer that owns a Tandem workspace ("Controller") and
CHD Labs, [Address] ("Processor"). It applies to personal data the Processor
processes for the Controller through Tandem, and forms part of the
[terms of service](terms-of-service.md).

## 1. Subject, duration, nature and purpose

* **Subject:** providing Tandem: storing tasks, specifications, approvals,
  conversations, check results and audit logs; processing source code on
  hosted runners; coordinating company runners.
* **Duration:** as long as the workspace exists, plus deletion periods below.
* **Nature:** hosting, storage, transmission, automated processing by hosted
  runners and Copilot sessions started by the Controller's users.
* **Purpose:** only to provide Tandem to the Controller.

## 2. Data and data subjects

* **Data subjects:** the Controller's users (employees, contractors), and
  people named in the Controller's content or code (for example authors in
  commit history).
* **Categories:** identity and contact data from GitHub (login, name, email),
  usage and audit data, content the users enter, and personal data contained
  in source code. No special categories are intended; the Controller does not
  put them into Tandem.

## 3. Processor's obligations

The Processor:

1. processes personal data only on documented instructions from the
   Controller (these terms, the Controller's use of Tandem, and written
   instructions), unless the law requires otherwise, and tells the Controller
   if an instruction appears to break data protection law;
2. ensures that people authorised to process the data are bound by
   confidentiality;
3. takes the technical and organisational measures in Annex 1;
4. engages subprocessors only as in section 4;
5. helps the Controller answer data subjects' requests, with self-service
   export and deletion in Tandem;
6. helps the Controller with security, breach notification, impact
   assessments and prior consultation, considering the information available;
7. notifies the Controller of a personal data breach without undue delay,
   and where possible within 48 hours of becoming aware of it;
8. deletes or returns all personal data at the end of the service, at the
   Controller's choice: workspace data is deleted within 30 days of deletion
   or termination, backups rotate within 35 days, unless law requires keeping
   it;
9. makes available the information needed to show compliance and allows
   audits, primarily by providing reports and certifications, and on-site
   audits with reasonable notice where these are insufficient.

## 4. Subprocessors

The Controller authorises the subprocessors listed in
[subprocessors.md](subprocessors.md). The Processor gives 30 days' notice of
a new or replaced subprocessor; the Controller may object on reasonable data
protection grounds and, if no solution is found, end the affected service.
The Processor imposes the same data protection obligations on subprocessors
and remains liable for them.

GitHub (including Copilot) and AWS CodeCommit are used under the Controller's
own agreements with them and are not subprocessors of the Processor.

## 5. Location and transfers

The Processor processes and stores personal data in the EU. A transfer to a
third country takes place only with a safeguard under Chapter V GDPR (an
adequacy decision such as the EU-US Data Privacy Framework, or Standard
Contractual Clauses), and is listed in the subprocessor list.

## 6. Company runners

When the Controller runs tasks on its own runners, source code stays on the
Controller's infrastructure; the Processor receives only the task data needed
to coordinate the work (status, logs the runner sends, the diff summary).

## Annex 1: technical and organisational measures

* **Confidentiality:** encryption in transit (TLS 1.2+) and at rest (AES-256,
  AWS KMS); per-workspace encryption keys; tenant isolation enforced in the
  database (row-level security); no customer tokens or secrets sent to
  browsers; staff access on a need-to-know basis with multi-factor
  authentication and logging.
* **Integrity:** tamper-evident (hash-chained) audit log per workspace;
  changes to infrastructure through reviewed code; Tandem never merges into
  default branches.
* **Availability and resilience:** multiple availability zones in
  eu-central-1, daily encrypted backups in the EU kept 35 days, tested
  restores, monitoring and on-call.
* **Isolation of code execution:** one short-lived sandbox per task on hosted
  runners, network limited to the services the task needs, wiped after the
  task.
* **Data minimisation and retention:** only data needed for the service;
  retention defaults (runner logs 30 days, audit log 1 year, deleted
  workspaces purged after 30 days) configurable by the Controller.
* **Testing and review:** dependency and container scanning, a penetration
  test before launch and yearly, a documented incident response process.
