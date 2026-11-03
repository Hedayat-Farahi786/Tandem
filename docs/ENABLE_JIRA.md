# Enable Jira

Tandem works fully without Jira: tasks, specs, approvals and reports then
stay in Tandem. With Jira on, Tandem also:

- imports issues as tasks, by key or from a query, every few minutes
- posts the readiness result and each spec version to the issue
- can take the PM's approval from a reply on the issue
- posts the pull request links when they are open, and moves the issue to
  your review status
- comments on an imported issue when every pull request is merged

The only secret is the Jira token. It is stored in the OS keychain, never in
a file.

## 1. Create a token

- **Jira Cloud** (`yourcompany.atlassian.net`): create an API token at
  <https://id.atlassian.com/manage-profile/security/api-tokens>. Tandem
  signs in with your account email and this token.
- **Jira Data Center / Server**: create a personal access token in your Jira
  profile (Profile › Personal Access Tokens). No email is needed.

The token acts as you, so Tandem's comments appear under your name.

## 2. Settings › Jira

| Field | Value |
| --- | --- |
| Jira URL | `https://yourcompany.atlassian.net`, or your Data Center URL |
| Account email | your Atlassian email (Cloud only; empty for Data Center) |
| Jira API token | the token from step 1, saved to the keychain |
| Ready query (JQL) | which issues are ready for Tandem; default `status = "Ready for AI"` |
| Move to status after PRs | the status to move an issue to once its pull requests are open; default `In Review` |

Save, then run the doctor: the Jira check signs in and shows your Jira name.
The Jira card shows **Enabled**. Nothing else needs to change.

The setup wizard's **Jira (optional)** step asks for the URL, the email and
the token; the queries keep their defaults until you change them here.

## 3. Projects

In **Projects**, edit a project:

- **Import query (JQL)**: issues for this project, for example
  `project = SHOP AND status = "Ready for AI"`. Empty means the Ready query
  from Settings.
- **PM approval › In Jira**: the PM approves by replying on the issue. Add
  the **Jira account IDs of PMs**: only their replies count. (In Jira
  Cloud, the account ID is the last part of the address of a person's
  profile page.)

With one project, Tandem imports what the Ready query finds. With several,
it imports automatically only into projects that have their own Import
query, so an issue can't land in the wrong project.

## Using it

- **Automatic import**: every 5 minutes, each issue the query finds becomes a task, once, and goes to the
  readiness check. Its task key is the Jira key.
- **Import now**: **Tasks › Import from Jira**. Enter issue keys to import
  those, whatever their status, or leave it empty to run the query now.
- **PM approval in Jira**: when you approve a spec, Tandem posts it to the
  issue. The PM replies:
  - `approve` to approve that version
  - `changes: <what to change>` to send it back; Tandem redrafts the spec
    and posts the new version

  Replies from anyone not listed as a PM are ignored.

## Keychain on Linux

macOS (Keychain) and Windows (Credential Manager) need nothing. Linux needs a
Secret Service, which desktop sessions (GNOME, KDE) already run. The doctor
shows **OS keychain: pass** when one is usable.

On a server or over SSH without a desktop, run GNOME Keyring yourself.

> Not yet run on the reference machine: gnome-keyring isn't installed there,
> so this recipe hasn't been tested end to end yet.

```sh
sudo apt install gnome-keyring dbus-user-session libsecret-tools

# Start Tandem inside its own D-Bus session with an unlocked keyring.
# The keyring is created on first use and unlocked with the password you type.
dbus-run-session -- sh -c '
  read -rsp "Keyring password: " pw; echo
  printf "%s" "$pw" | gnome-keyring-daemon --unlock --components=secrets >/dev/null
  pnpm tandem
'
```

Check it with `pnpm tandem doctor` from the same session (replace
`pnpm tandem` with `pnpm tandem doctor` above). Everything stored this way
is encrypted with that password under `~/.local/share/keyrings/`.

If no keychain is usable, Tandem refuses to save the token and says so;
there is no file fallback by design.

## Turning Jira off

Clear the Jira URL, or **Remove** the token in Settings. Imported tasks keep
working; new reports stay in Tandem.
