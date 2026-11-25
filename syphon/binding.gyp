# The Syphon addon (src/syphon.mm), built by build.mjs (pnpm install runs it, or pnpm run syphon).
# macOS only. The Syphon framework's server code is in vendor/ (BSD licence: vendor/License.txt) and
# is compiled in: there's no Syphon.framework to install or ship.
{
  "targets": [
    {
      "target_name": "syphon",
      "conditions": [
        ["OS=='mac'", {
          "sources": [
            "src/syphon.mm",
            "vendor/SyphonServerBase.m",
            "vendor/SyphonServerConnectionManager.m",
            "vendor/SyphonMessaging.m",
            "vendor/SyphonMessageSender.m",
            "vendor/SyphonMessageReceiver.m",
            "vendor/SyphonCFMessageSender.m",
            "vendor/SyphonCFMessageReceiver.m",
            "vendor/SyphonMessageQueue.m",
            "vendor/SyphonPrivate.m",
            "vendor/SyphonDispatch.c"
          ],
          "include_dirs": ["<!(node -p \"require('node-addon-api').include_dir\")", "vendor"],
          "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS", "NAPI_VERSION=6"],
          "xcode_settings": {
            "CLANG_ENABLE_OBJC_ARC": "YES",
            "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
            "CLANG_CXX_LIBRARY": "libc++",
            "MACOSX_DEPLOYMENT_TARGET": "11.0",
            "OTHER_CFLAGS": ["-include", "<(module_root_dir)/vendor/Syphon_Prefix.pch", "-Wno-deprecated-declarations"],
            "OTHER_CPLUSPLUSFLAGS": ["-Wno-deprecated-declarations"],
            "OTHER_LDFLAGS": ["-framework", "Foundation", "-framework", "AppKit", "-framework", "IOSurface", "-framework", "CoreVideo"]
          }
        }]
      ]
    }
  ]
}
