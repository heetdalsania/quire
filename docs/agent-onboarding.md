# Join a Quire team vault with an agent

Quire needs no account, but one computer must run the authoritative vault. The host shares
an expiring capability link; that link is a credential, so send it privately. A link to
`localhost` or `127.0.0.1` works only on the host's own computer. Remote teammates need an
HTTPS address supplied by a trusted private network or tunnel. Quire does not provide that
network service or keep a sleeping/offline host available.

## Host

1. Start Quire on a dedicated folder containing only Markdown the team may access.
2. In **Share**, select the intended access level and either **This file** or **Whole vault**.
   An agent that must update several files needs a whole-vault **Edit** link.
3. Check that the resulting URL uses the reachable HTTPS host, not `localhost`, before
   sending it through a private channel. Do not put the link in a public repository.

## Teammate

1. Open the shared link in a browser. The page shows the granted access; no Quire account
   or local Quire server is needed on the teammate's computer.
2. Open **Connect agent** and wait for **Link verified**. The dialog checks the link and
   document scope. If it says expired, ask the host for a new link. This check does not
   mean the agent itself is connected.
3. Choose the installed agent client and platform. Copy its configuration into that
   client's private MCP settings, then reload the client if it requires a restart. The
   configuration contains the share credential; do not paste it into a public prompt,
   repository, screenshot, or chat.
4. Ask the agent to read the document through Quire MCP. Its presence in that document
   confirms it joined the live editor. A successful read verifies the actual MCP path.
   View/comment links produce a read-only sample task; an **Edit** link is required for
   document changes.

Quire itself does not charge for creating a link. A tunnel, always-on host, and any AI
model used by the teammate's client are separate services with their own terms and costs.
No setup step here signs up for one automatically. Revoking a link immediately removes
its access; without an opt-in private share store, a server restart also invalidates links.
