# 🍬 Candy Crunch — Match-3 Puzzle Game
https://candycrush-livid.vercel.app/
A complete Candy Crush–style game built with **plain HTML + CSS + JavaScript**.
No build step, no dependencies, no external assets — all candy art is generated
SVG and all sounds are synthesized with the Web Audio API.

## ▶ How to run

**Option 1 — just open it:**
Double-click `index.html` (or drag it into any modern browser).

**Option 2 — serve locally (recommended on mobile):**
```bash
cd candy-crush
python3 -m http.server 8000
# then visit http://localhost:8000
```

## 🎮 How to play

- **Swap**: drag a candy onto an adjacent one, or tap two neighbors.
- Only swaps that create a match of **3+** are allowed (illegal swaps bounce back).
- Reach the **target score** before your **30 moves** run out.

### Special candies
| Match | Creates | Effect when cleared |
|---|---|---|
| 4 in a row | **Striped candy** | Blasts a whole row or column |
| 5 in a row | **Color bomb** | Wipes every candy of one color |
| T / L shape | **Wrapped candy** | 3×3 explosion |

### Special combos (swap two specials together)
- Striped + Striped → row **and** column blast
- Striped + Wrapped → 3 rows **and** 3 columns
- Wrapped + Wrapped → 5×5 mega explosion
- Bomb + candy → clears that color
- Bomb + Striped → turns that color into stripes and fires them all
- Bomb + Wrapped → color wipe + explosion
- Bomb + Bomb → clears the **entire board**

## ✨ Features

- Score / moves / target HUD with animated progress bar
- Cascade combos with multiplier and "Sweet! / Tasty! / Delicious!" banners
- Floating score text, particles, screen shake, confetti
- Hint system (auto after 8 s idle, or 💡 button)
- Shuffle button + automatic shuffle when no moves remain
- Level progression (target grows ~35% each level) + leftover-move bonus
- Pause, restart, sound toggle (synthesized SFX, preference saved)
- Fully responsive, touch + drag support via Pointer Events
- Best score saved in `localStorage`

## 📁 Files

- `index.html` — markup & overlays
- `style.css` — candy theme, board, animations, responsive layout
- `script.js` — game engine (commented, sectioned by module)
