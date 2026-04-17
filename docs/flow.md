## 1. Building the Base Timeline

### Actions

* **Drag clip (Mouse)** → from media pool to timeline
* **Append (Keyboard: `Shift + F12`)** → auto place at end
* **Insert (Keyboard: `F9`)** → push clips forward
* **Overwrite (Keyboard: `F10`)** → replace section

### What user is doing

* Left-click + drag map clip → drop on timeline
* Press **Shift + F12 repeatedly** to build sequence fast
* Use **F9/F10** when restructuring flow

---

## 2. Navigating the Timeline

### Actions

* **Scrub (Mouse drag on timeline ruler or playhead)**
* **Zoom (Mouse wheel OR `Alt + Scroll`)**
* **Frame step (`←` / `→`)**
* **Jump cuts (`↑` / `↓`)**

### What user is doing

* Drag playhead to preview movement
* Scroll to zoom into tight animation areas
* Tap arrow keys to align exact frames

---

## 3. Trimming for Timing

### Actions

* **Trim edges (Mouse drag clip edge)**
* **Ripple trim (`Ctrl + Shift + [` / `]`)**
* **Blade tool (`B`) → click to cut**
* **Trim to playhead (`Ctrl + \`)**

### What user is doing

* Hover edge → cursor changes → drag to shorten/extend
* Press **B**, click where movement should cut
* Switch back to selection (`A`)
* Use ripple trim to avoid gaps

---

## 4. Creating Map Movement (Keyframing)

### Actions

* **Select clip (Mouse click)**
* **Open Inspector (top-right panel)**
* **Click diamond icon (Mouse) → add keyframe**
* **Move playhead (Mouse drag / arrow keys)**
* **Change values (Mouse drag or type numbers)**

### What user is doing

1. Click clip
2. Move playhead to start → click **keyframe button** (Position/Zoom)
3. Move playhead forward
4. Drag map in viewer OR adjust X/Y/Zoom
5. New keyframe auto-created

→ This creates motion between locations

---

## 5. Adjusting Motion Smoothness

### Actions

* **Open curve editor (Mouse click icon)**
* **Drag bezier handles (Mouse drag)**
* **Right-click keyframe → Ease In / Ease Out**

### What user is doing

* Click curve icon
* Drag handles to smooth movement
* Add easing so motion doesn’t look robotic

---

## 6. Direct Viewer Interaction (Important)

### Actions

* **Drag inside viewer (Mouse drag)** → move map
* **Scroll (Mouse wheel)** → zoom
* **On-screen transform handles (drag corners/center)**

### What user is doing

* Instead of typing values, they:

  * Drag map to next city
  * Scroll to zoom into region

(This is how most map animations are actually done)

---

## 7. Adding Transitions Between Locations

### Actions

* **Open effects panel (Mouse click)**
* **Drag transition onto cut**
* **Adjust duration (Mouse drag edges)**

### What user is doing

* Drag **cross dissolve** onto cut
* Stretch it by dragging ends
* Preview using spacebar

---

## 8. Layering Map Elements (Routes, Labels)

### Actions

* **Drag overlays to upper tracks**
* **Move clips vertically (Mouse drag)**
* **Resize clips (Mouse drag edges)**

### What user is doing

* Base map → Track 1
* Route animation → Track 2
* Labels/icons → Track 3
* Drag clips to align timing

---

## 9. Using Markers for Locations

### Actions

* **Add marker (`M`)**
* **Double press `M` → edit marker**
* **Click marker to jump**

### What user is doing

* Press **M at each location**
* Rename marker (e.g., “Delhi”, “Mumbai”)
* Snap animations to these points

---

## 10. Snapping for Precision

### Actions

* **Toggle snapping (`N`)**
* **Drag clips/keyframes → auto-align**

### What user is doing

* Turns snapping ON
* Moves clips → they lock onto:

  * markers
  * other clips
  * playhead

---

## 11. Deleting & Adjusting Flow

### Actions

* **Delete (`Backspace`)**
* **Ripple delete (`Shift + Backspace`)**
* **Undo (`Ctrl + Z`)**

### What user is doing

* Select unwanted section → delete
* Use ripple delete to avoid gaps
* Undo if timing breaks

---

# Full Real Workflow (Condensed)

1. Drag map clip → timeline
2. Press `Shift + F12` to build sequence
3. Add markers (`M`) for locations
4. Click clip → add keyframe (start)
5. Move playhead → drag map in viewer
6. Repeat for each location
7. Trim clips using mouse drag
8. Add transitions via drag-drop
9. Adjust curves for smooth motion
10. Layer routes + labels on top tracks
11. Use snapping + markers to align everything

---

# Key Insight (What actually matters)

* **Mouse = 80% of workflow**

  * dragging clips
  * dragging map in viewer
  * adjusting keyframes

* **Keyboard = speed**

  * cutting (`B`)
  * markers (`M`)
  * snapping (`N`)
  * playback + navigation

---

If you're building your own editor (which it looks like you are), the important takeaway is:

→ Everything revolves around
**drag → preview → adjust → repeat**

Not menus.

---