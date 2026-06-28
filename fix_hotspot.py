fp = r'd:\桌面\tao-zi-jiao-map-master-20260618T135953Z-3-001\tao-zi-jiao-map-master\tao-zi-jiao-map-master\script.js'
text = open(fp, 'r', encoding='utf-8').read()
old = "        cssClass: 'custom-hotspot-marker'"
new = "        cssClass: 'custom-hotspot-marker',\r\n        createTooltipFunc: function () {\r\n            return '<div class=\"custom-hotspot-inner\">\U0001f4cd</div>';\r\n        }"
if old not in text:
    print('old text not found')
    raise SystemExit
ntext = text.replace(old, new, 1)
open(fp, 'w', encoding='utf-8').write(ntext)
print('ok')
