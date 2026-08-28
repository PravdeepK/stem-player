{
  "targets": [
    {
      "target_name": "haptics",
      "sources": [],
      "conditions": [
        ["OS=='mac'", { "sources": ["src/haptics.mm"] }]
      ],
      "include_dirs": ["<!@(node -p \"require('node-addon-api').include\")"],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS", "NAPI_VERSION=8"],
      "xcode_settings": {
        "MACOSX_DEPLOYMENT_TARGET": "10.13",
        "OTHER_CPLUSPLUSFLAGS": ["-std=c++17", "-stdlib=libc++"],
        "OTHER_LDFLAGS": ["-framework AppKit"]
      }
    }
  ]
}
