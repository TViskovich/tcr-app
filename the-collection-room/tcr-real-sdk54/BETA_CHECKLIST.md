# CacheCase Beta Checklist

## Fresh Test Baseline — Aug 28, 2026

- All 10 test accounts reset to fresh state
- All previous user-generated database data cleared
- All 148 orphaned storage objects removed
- Auth accounts preserved
- Shared `card_types` catalog preserved
- One ownerless registry row intentionally retained
- Collections `+ New Folder` bottom clearance fixed — button now scrolls fully above the floating nav
- Bottom navigation scroll animation removed — nav is now pinned/stationary across all screens
- Collection placeholder card tiles removed — horizontal previews and folder grids now render only real cards
- Folder search UI compacted — full-width search bar replaced with header search icon and expandable inline search
- Folder card grid spacing tightened — reduced gutters to 1px and removed tile borders for true Instagram-style photo separation
- Collections preview rows restyled — main folder previews now use 1px gutters, square edges, and borderless card tiles
- Collections preview navigation fixed — tapping a card now opens that specific item; folder title/chevron still opens the folder gallery
- Folder detail header restructured — folder title now has a full-width row, with like/comment/bookmark/share controls moved beneath it
- Folder comments sheet animation refined — removed spring/bounce and replaced it with smooth cubic timing on open and snap-back
- Photo crop editor upgraded — added WYSIWYG 3:4 / 1:1 crop frames, rule-of-thirds grid, zoom/pan clamping, and accurate exported framing
- Collections "+ Add" menu added — users can choose Add Folder or preview the Add Item flow; item saving remains disabled until unfiled-item support is implemented
- Collection privacy label made dynamic — title now switches between Public Collection and Private Collection to match the active visibility state
- Item image viewer upgraded — added Instagram-style pinch-to-zoom with focal-point scaling, bounded panning, and smooth automatic snap-back
- Add Item feed-sharing removed — item creation now only saves the item itself; public feed sharing remains a separate Share Card action
- Share Card privacy enforcement added — private items and items in private collections are now blocked from public feed sharing in both the picker UI and submit handler
- Item-level privacy added — items now support independent Public/Private visibility with folder + item “most restrictive wins” enforcement across RLS and signed image delivery
- Private-item feed sharing restricted — effectively-private cards can no longer create public feed posts
- Delete Item moved into Edit Item — destructive action removed from the normal Item Detail screen and placed at the bottom of the edit form
- Grails styling refined — item tiles now use square 90° corners, with the Grails hero container radius reduced from 20px to 12px
- Folder hero covers added — owners can choose a folder item or Photo Library image as the hero, with privacy-aware signed image delivery
- Folder cover privacy hardened — default first-card covers now skip private items for non-owners and fall back to the newest public item
- Folder cover picker fixed — cover item tiles now use explicit numeric dimensions and render correctly in the iOS picker sheet
- Folder cover Photo Library flow fixed — native picker now launches after modal dismissal and uploaded covers persist and resolve correctly
- Folder item hero adjustment added — item-based folder covers can now be panned and zoomed non-destructively inside the exact hero frame, with saved crop positioning preserved per folder
- Item detail owner row refined — avatar/@username spacing tightened and legacy carousel top margin removed for a compact Instagram-style header-to-image transition

Use this as the baseline for all new TestFlight testing and bug reports.