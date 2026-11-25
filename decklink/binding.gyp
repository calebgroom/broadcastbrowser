# The DeckLink addon (src/decklink.cc), built by build.mjs (pnpm install runs it, or
# pnpm run decklink). Blackmagic's SDK headers are in sdk/; their dispatch code loads Desktop
# Video's library when the app runs, so this builds without Desktop Video installed.
{
  "targets": [
    {
      "target_name": "decklink",
      "sources": ["src/decklink.cc"],
      "include_dirs": ["<!(node -p \"require('node-addon-api').include_dir\")"],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS", "NAPI_VERSION=6"],
      "cflags_cc": ["-std=c++17"],
      "conditions": [
        ["OS=='mac'", {
          "sources": ["sdk/Mac/DeckLinkAPIDispatch.cpp"],
          "include_dirs": ["sdk/Mac"],
          "xcode_settings": {
            "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
            "CLANG_CXX_LIBRARY": "libc++",
            "MACOSX_DEPLOYMENT_TARGET": "11.0",
            "OTHER_CPLUSPLUSFLAGS": ["-Wno-deprecated-declarations"],
            "OTHER_LDFLAGS": ["-framework", "CoreFoundation"]
          }
        }],
        ["OS=='linux'", {
          "sources": ["sdk/Linux/DeckLinkAPIDispatch.cpp"],
          "include_dirs": ["sdk/Linux"],
          "libraries": ["-ldl", "-lpthread"]
        }]
      ]
    }
  ]
}
