split-reader-open =
    .label =
        { $over ->
            [yes] Open Together in Split View (max { $max }, { $count } selected)
           *[no] Open Together in Split View ({ $count })
        }
split-reader-open-in-tab =
    .label = Open in Split View of
split-reader-target-tab =
    .label =
        { $full ->
            [yes] { $title } (full)
           *[no] { $title }
        }
split-reader-show-right =
    .label = Add Split Pane
split-reader-candidate =
    .label =
        { $kind ->
            [tab] Open tab: { $title }
           *[sibling] Same item: { $title }
        }
split-reader-pick-from-library =
    .label = Choose from Library…
split-reader-close-right =
    .label = Close All Split Panes
split-reader-move-left =
    .title = Move to Left Column
split-reader-move-right =
    .title = Move to Right Column
split-reader-move-up =
    .title = Move Up
split-reader-move-down =
    .title = Move Down
split-reader-close-pane =
    .title = Close This Pane
split-reader-file-missing = Attachment file not found: { $title }
split-reader-no-attachment = This item has no attachment that can be opened in the reader (PDF, EPUB or snapshot).
split-reader-full = This tab is full (at most { $columns } columns with { $rows } panes each).
