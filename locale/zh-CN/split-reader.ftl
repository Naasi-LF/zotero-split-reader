split-reader-open =
    .label =
        { $over ->
            [yes] 一起分屏打开（最多 { $max } 个，选了 { $count } 个）
           *[no] 一起分屏打开（{ $count } 个）
        }
split-reader-open-in-tab =
    .label = 分屏打开到
split-reader-target-tab =
    .label =
        { $full ->
            [yes] { $title }（已满）
           *[no] { $title }
        }
split-reader-show-right =
    .label = 添加分屏
split-reader-candidate =
    .label =
        { $kind ->
            [tab] 已打开的标签：{ $title }
           *[sibling] 同一条目：{ $title }
        }
split-reader-pick-from-library =
    .label = 从文库中选择…
split-reader-close-right =
    .label = 关闭所有分屏
split-reader-move-left =
    .title = 移到左边一列
split-reader-move-right =
    .title = 移到右边一列
split-reader-move-up =
    .title = 上移
split-reader-move-down =
    .title = 下移
split-reader-close-pane =
    .title = 关闭这一格
split-reader-file-missing = 找不到附件文件：{ $title }
split-reader-no-attachment = 这个条目下没有能在阅读器里打开的附件（PDF、EPUB 或网页快照）。
split-reader-full = 这个标签已经放满了（最多 { $columns } 列、每列 { $rows } 个）。
