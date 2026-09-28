COOLRPG WEB — BROWSER MULTIPLAYER BUILD

What this package provides
--------------------------
- Browser UI for Chrome / Edge / modern mobile browsers
- No Python or EXE required for players
- 3-player cooperative rooms
- PvP rooms for exactly 2 players
- Endless co-op with 5 difficulties
- Server-side turn validation and combat state
- Persistent player profile/settings in browser localStorage
- Shop, weapons, armor, classes, upgrades, inventory, stats
- Team contribution summary after co-op victories
- Room chat/activity log
- Trade API foundation

How to test locally on Windows
------------------------------
1. Install Node.js 18 or newer on the computer that will host the game server.
2. Open this folder in a terminal.
3. Run: node server.js
4. Open: http://localhost:3000

How your friends connect on the same Wi-Fi
------------------------------------------
Open the host computer's local IP followed by :3000, for example:
http://192.168.1.10:3000

For internet play
-----------------
Deploy this folder to any Node.js web host that supports a long-running HTTP server.
The process must expose the PORT environment variable if the host assigns one.
Players only need the public HTTPS URL.

Important
---------
Rooms are held in server memory. Restarting the server closes active rooms.
Player profiles are stored locally in each browser and are synced to the current room.
The app intentionally uses normal HTTP polling instead of WebSockets so the server is easy to deploy and the browser needs no extra software.

Source basis
------------
Enemy and weapon values in game-data.json were taken from the supplied CoolRPG Python source where applicable. The browser UI/network layer is a separate web implementation rather than a literal Kivy-to-JavaScript conversion.
