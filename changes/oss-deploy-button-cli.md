内部
zh: 安装包可以不绑定服务器打包：这样的包只能带 `--server <地址>` 安装，`latest.json` 标上 `"unbound": true`；不再在缺服务器时落到默认地址，换服务器时也不把这台电脑的令牌发给任何服务器。带服务器打包的产物和以前逐字节相同。
en: The Skill package can be packed without a server: such a package installs only with `--server <address>`, and `latest.json` marks it `"unbound": true`. It never falls back to the default address, and on a server change it sends this computer's token to no server. Packing with a server gives the same bytes as before.
