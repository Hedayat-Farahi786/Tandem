# Enable Jira

Tandem works fully without Jira: tasks, specs, approvals and reports then
stay in Tandem. With Jira on, Tandem also:

- imports issues as tasks, by key or from a query, every few minutes
- posts the readiness result and each spec version to the issue
- can take the PM's approval from a reply on the issue
- posts the pull request links when they are open, and moves the issue to
  your review status
- comments on an imported issue when every pull request is merged

Connecting takes a few clicks, and nobody writes a query.

## 1. Connect Jira

Open **Settings › Jira** (or the setup wizard's **Jira** step) and choose
**Connect Jira**.

- **Jira Cloud, in the web app:** you go to Atlassian, sign in, and choose
  **Accept** to allow Tandem. If your account reaches several Jira sites,
  Tandem asks which one. You come back connected. The sign-in renews itself;
  nobody copies an address, an email or a token.
- **Jira Data Center, or the local app:** a short form instead.
  1. **Your Jira:** paste any link from your Jira (an issue, a board), or
     just the site's name (`acme` for `acme.atlassian.net`).
  2. Jira Cloud only: **your Atlassian email**.
  3. **The token:** the form links to the page where you make one, at
     Atlassian (**Create API token**) or in your Data Center profile
     (**Personal access tokens**). Paste it.

  Tandem checks the token with Jira before keeping it, and says if Jira
  turned it down.

Settings then shows the site, and whose name Tandem's comments in Jira carry
(yours). Tokens are kept in the OS keychain (local app) or sealed for the
workspace (web app), never in a file. **Disconnect** removes them.

## 2. What Tandem picks up

Once Jira is connected, Settings › Jira lists your Jira's own statuses:

| Setting | What to choose |
| --- | --- |
| **Tandem picks up issues in** | the status of issues that are ready for Tandem, such as `Ready for AI` |
| **When the pull requests are open, move the issue to** | the status for review, such as `In Review` |

**Write the query yourself (JQL)** is still there for anything a status
can't say.

## 3. Projects

In **Projects**, edit a project:

- **Jira project:** choose it from the list. Its issues in the status from
  step 2 become this project's tasks. **Write the query yourself (JQL)** is
  there too.
- **PM approval › Via Jira replies:** search for the PMs by name and add
  them. Only their replies count.

With one project, Tandem imports what the status finds anywhere. With
several, it imports automatically only into projects that have a Jira
project (or their own query), so an issue can't land in the wrong project.

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

## Atlassian's sign-in for the local app

The local app offers Atlassian's sign-in when it has an Atlassian app of its
own: create an OAuth 2.0 (3LO) app at
<https://developer.atlassian.com/console/myapps/> (as in
[DEPLOYMENT.md](DEPLOYMENT.md#jira-connect-jira-with-atlassians-sign-in)),
with the callback `http://localhost:<port>/auth/jira/callback`, and start
Tandem with `TANDEM_JIRA_CLIENT_ID` and `TANDEM_JIRA_CLIENT_SECRET`
(`TANDEM_JIRA_REDIRECT_URL` if the callback differs). Without them, the form
with a token is used.

## Turning Jira off

**Disconnect** in Settings › Jira. Imported tasks keep working; new reports
stay in Tandem.
