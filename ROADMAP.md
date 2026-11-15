# Mytinerary roadmap

Things we've decided to do later. The product vision (inspire → plan → on the trip → after the trip) lives in the README and project notes.

## Next up
- **Food & drink as its own step.** Separate from activity anchors: quickly pick a handful of restaurants, cafés and bars to try, then drop them into breakfast, lunch and dinner slots across the days. If the travel profile says food isn't a priority, say so ("We know food isn't a big deal for you") and let them skip it, with simple, well-placed meals filled in automatically.
- **Multiplayer planning.** Several people plan one itinerary together: shared wish lists, votes on anchors, everyone's travel profiles blended, and per-person tracks merged into one plan. Today: the owner can share a read-only link, and per-person tracks exist inside one itinerary.
- **Review the "Other" answers regularly.** Free-text answers (occasion "Other" and similar) are counted on the server (`GET /api/admin/answers`). Every few weeks, promote the most common ones to real options and adjust prompts.
- **Offline mode for the on-trip view.** The day's plan, maps and confirmations available without signal.

## Later
- **Learned preferences, deeper.** We already count which kinds of places someone picks and nudge suggestions toward them, while always mixing in things unique to each place. Next: learn from what they skip, swap away from, and rate after the trip.
- **Trips from your network.** Inspiration drawn from what friends planned and loved (needs sharing and accounts across many users).
- **Post-trip feedback.** Confirm what you loved, add photos, feed it back into recommendations.
- **Google verification.** Testing mode limits Gmail/Calendar to 100 test users and expires connections after 7 days. Going wider needs Google's review (Gmail requires a paid security assessment; Calendar-only is much easier).
