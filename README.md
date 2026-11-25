# Kitchen Table Beat the Heat

A phone-friendly scorekeeper for Hasbro's Beat the Heat (a version of Take 5 / 6 nimmt!). Part of the Game Night set: runs on its own on GitHub Pages, and on the Game Night server (klisby) it also saves every round to SQLite.

**Scoring:** after each round, enter the flames on the cards each player took. Points are bad. When anyone reaches the limit (66 by default; 50 or 100 at setup), the game ends and the lowest total wins.

CSV columns: `Round, Player, Points`.

Not affiliated with Hasbro, which owns the Beat the Heat name.
