# Ruben Games

The arcade at rubengames.com, hosted on Cloudflare Pages.

- `index.html` – the arcade home page
- `balloon.html`, `snowman.html`, `chocoholic.html`, `forest.html`, `duck.html`, `door.html` – the games
- `admin.html` – the admin page (rubengames.com/admin, needs the admin password)
- `_worker.js` – the server: sign-in, leaderboards and admin. It stores everything in a Cloudflare D1
  database connected to this site under the name `DB`. There are no passwords or keys in any file here.
- `rg-api.js` – lets the pages talk to the server

To update the site, drag the changed files onto this repository on github.com and commit.
Cloudflare publishes the new version about a minute later.
