TagShelf 2.0 - a file browser where every file can have as many tags as you like
================================================================================

START:  unzip anywhere, double-click TagShelf.exe (no install). It opens in its own window
        using Microsoft Edge or Chrome, which Windows already has.
        Windows SmartScreen may warn about an unsigned app: "More info" -> "Run anyway".

THE WINDOW
  Left    folder tree: Quick access, your drives, every folder. Right-click a folder to pin it.
  Middle  the files of the current folder. Double-click opens a file or folder.
          Drag files onto a folder to move them (hold Ctrl to copy).
  Right   "Tags" tab: tags of what you selected (select several to tag them together),
          suggestions, quick tags, rating, details.
          "Filter" tab: filter THIS folder by tag; tick "Include subfolders" to cover everything below it.
  Press F1 for all keyboard shortcuts. Digits 1-9 toggle your nine most used tags on the selection.

TAGS FOLLOW YOUR FILES when you rename, move or copy them inside TagShelf. If you move files
outside TagShelf, open the new folder: TagShelf recognises them (same name, size and date) and
reconnects the tags. Your files themselves are never modified.

TAG SUGGESTIONS (they only suggest - nothing is applied until you click)
  A small, built-in "AI" - no download, no internet, nothing leaves your computer. It compares each
  picture/video with the ones you have already tagged (colours, layout, edges), looks at file and
  folder names, and at tags you often combine. It starts suggesting after ~6 tagged pictures.
  It is lightweight, not a big neural network: great for "more of what I already tagged", weaker
  at recognising brand-new subjects. Settings > "Test how well it does" measures it on YOUR tags.
  Menu (sliders icon) > "Suggest tags for the untagged files here" lets you review a whole folder.

DOWNLOADS
  When a picture or video finishes downloading, a small window offers suggested tags, plus an
  optional "move it to a folder". It works whichever browser you use and WHICHEVER folder you save to:
  TagShelf watches the whole drive ("Watch the whole drive" in Settings, on by default) and only offers
  files that Windows marked as "downloaded from the internet" (Edge, Chrome, Firefox and Brave add that
  mark on NTFS drives). Pictures you copy or create yourself are ignored. Turn the option off to watch only
  the folders you list under Settings > Downloads (those are offered even without the mark).
  For this to work while the main window is closed, TagShelf keeps running quietly in the background - it
  asks you once. Use "Quit TagShelf" (bottom left) to stop it.

EXTRAS: undo (Ctrl+Z) for rename/move/tag changes - find duplicate files - batch rename -
  find similar pictures - ratings - group by tag/type/year/month/rating - saved filters -
  tag manager (rename, merge, colour) - Recycle Bin for deletes - missing-file cleanup.

YOUR DATA   %AppData%\TagShelf   (library.json = tags, ratings, settings; thumbs\ = preview cache).
  Back up library.json to back up your tags. A copy of the old version-1 library was saved as
  library.v1.backup.json when you first started 2.0. To keep everything next to the exe instead,
  start it with:  TagShelf.exe --data "D:\path\to\folder"
