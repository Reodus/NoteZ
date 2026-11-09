# Flashcards

Write questions and answers in your notes. NoteZ turns them into flashcards and
schedules each review for when you're about to forget the card. The scheduler
is **FSRS**, the algorithm used by Anki.

The card syntax is the one used by Obsidian's *Spaced Repetition* plugin, so
existing card notes work unchanged.

---

## Making cards

Tag a note `#flashcards`, either in the text or in the frontmatter
(`tags: [flashcards]`). Every card in that note becomes part of a deck.

### One-line cards

```markdown
perro::dog
```

The question is on the left of `::` and the answer on the right.

```markdown
gato:::cat
```

Three colons make **two cards**: *gato → cat* and *cat → gato*.

A list marker in front is fine (`- perro::dog`). `::` inside inline code
(`` `std::vector` ``) doesn't make a card.

### Multi-line cards

```markdown
What are the three primary colours?
?
Red, yellow and blue.
(In painting; light uses red, green and blue.)
```

The question comes first, then a line with only `?`, then the answer. The
card ends at the next blank line. With `??` you get two cards, one each way.

### Cloze cards

Hide part of a sentence with a highlight:

```markdown
The ==mitochondria== is the ==powerhouse== of the cell.
```

That's two cards: each one hides one highlight and shows the other.

The Anki syntax works too. Parts with the same number are hidden together,
and `::` adds a hint:

```markdown
{{c1::Paris}} is the capital of {{c1::France::country}}; {{c2::Rome}} of Italy.
```

### What a card can contain

Cards are Markdown:
- **Bold**, *italics* and `code`.
- `$math$` and `$$display math$$`, typeset like in the editor.
- Images: `![[diagram.png]]`.
- Links: `[[Note]]`. Clicking one closes the review and opens the note.
- Lists.

Right-to-left text works as in notes.

### What is skipped

- Code blocks and `$$` math blocks.
- The frontmatter.
- Headings.
- A line that holds only tags (like the `#flashcards` line itself).

---

## Decks

The tag sets the deck:

| Tag | Deck |
|---|---|
| `#flashcards/Spanish` | Spanish |
| `#flashcards/Spanish/verbs` | Spanish/verbs (studying "Spanish" includes it) |
| `#flashcards` | the note's folder (`Default` at the vault root) |

---

## Reviewing

Open **Flashcards** with **Ctrl+Shift+R**, from the command palette
(**Review flashcards**, **Flashcards: decks and statistics**), or by clicking
**N due** in the status bar. The status bar item appears only when cards are
due.

The deck list shows for each deck:
- **new**: cards never studied (up to today's limit)
- **learning**: cards going through their first short steps
- **due**: reviews

Click **Study**, or **Study all**.

For each card:

1. Read the question and recall the answer.
2. Press **Space** (or click **Show answer**).
3. Grade yourself. The time above each button is when you'll see the card
   again with that grade.

| Key | Grade | Use it when |
|---|---|---|
| **1** | Again | You forgot |
| **2** | Hard | You remembered with real effort |
| **3** or **Space** | Good | You remembered |
| **4** | Easy | It was effortless |

Other keys:
- **U** (or **Ctrl+Z**) undoes the last grade.
- **E** opens the note at the card, to fix a typo.
- **Esc** closes the dialog.

New cards go through short **learning steps** (1 and 10 minutes by default)
before their first interval in days. A card you forget goes through the
**relearning steps** (10 minutes). Learning cards come back during the same
session; when nothing else is left, cards due in the next 20 minutes are
shown early.

### Statistics

Below the decks:
- **Activity**: reviews per day for the last six months.
- **Due in the next 30 days**: a forecast.
- **Card counts**: new, learning, young (interval under 21 days) and mature.

---

## Settings

**Settings → Flashcards**:

| Setting | Default | Meaning |
|---|---|---|
| Desired retention | 90% | How likely you should be to remember a card when it's due. Higher means more reviews. |
| New cards per day | 20 | How many unseen cards are introduced each day |
| Maximum interval | 36500 days | The longest gap between reviews |
| Learning steps | `1 10` | Minutes, for new cards |
| Relearning steps | `10` | Minutes, after **Again** |

FSRS uses the default FSRS-6 parameters. Intervals get a small random spread,
so that cards learned together don't all come due on the same day.

---

## Where progress is kept

Review progress lives in `.notez/srs.json` inside the vault. Your notes are
never changed, and the file syncs with the rest of `.notez`
([Sync](HISTORY.md)).

Each card is identified by its text, so you can move or rename the note
freely. **Editing a card's text makes it a new card.** That's usually what
you want after fixing a wrong answer.

### Coming from Obsidian

Obsidian's plugin writes `<!--SR:!2026-01-05,3,250-->` after each card. NoteZ
leaves these comments out of the cards. For a card it hasn't seen before, it uses the comment's
date as the first due date, so already-learned cards don't all show up as new
on day one. It doesn't write these comments itself.

---

## In the PDF

Cards print as written: `perro::dog`, the `?` line, and highlights for cloze
parts. Card notes stay readable as notes.
