状态 对话记忆
RP1 开场白
wechat1 RP1
RP2 RP1->wechat1
wechat2 RP1->wechat1->RP2
RP3 RP1->wechat1->RP2->wechat2
压缩1 RP1->wechat1->RP2->wechat2->RP3
RP4 压缩1
wechat4 压缩1->RP4
RP5 压缩1->RP4->wechat4
压缩2 压缩1->RP4->wechat4->RP5
wechat5 压缩2


（实现对应 docs/ARCHITECTURE.md §8：压缩素材必须按上面的**时间顺序**交错送入模型，
即 RP1→wechat1→RP2→wechat2→RP3，顺序取自统一时间线 wechat_timeline；
不能「先全部 RP、再全部微信」，否则微信段会被判成发生在最后一轮之后。）
