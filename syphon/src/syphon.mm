// The Syphon addon: a Syphon server (macOS's way of sharing video frames between apps on one Mac,
// through IOSurface: shared GPU memory, no network) that publishes the output's frames, the BGRA
// buffers that go to NDI and SDI.
//
// It uses the Syphon framework's own server code (vendor/, from github.com/Syphon/Syphon-Framework,
// BSD licence: vendor/License.txt), compiled in, so there's no Syphon.framework to ship: just
// SyphonServerBase, the part that announces the server to clients and hands them the IOSurface, and
// none of its OpenGL or Metal renderers (the frames are already pixels in memory: they're copied
// into the surface).
//
// JS:
//   const { Server } = require('./build/Release/syphon.node');
//   const s = new Server('Broadcast Browser');   // announced to Syphon clients (OBS, Resolume, QLab…)
//   s.publish(bgra, 1920, 1080, bottomUp)   // a frame; bottomUp: bottom row first (see below)
//   s.hasClients()                          // anyone watching (no copy needed otherwise)
//   s.name = 'Other'                        // renamed for every client
//   s.stop()                                // retired (also when it's garbage-collected)
//
// Orientation: Syphon carries none. The framework's OpenGL server writes surfaces bottom row first
// (OpenGL's way), and OpenGL clients (OBS among them) show them upright; its Metal server writes
// top row first. bottomUp = true writes the OpenGL way.
//
// Everything here runs on the main thread (Electron's main process): the server's discovery
// notifications are delivered by the main run loop.

#import <Foundation/Foundation.h>
#import <IOSurface/IOSurface.h>
#include <napi.h>
#include <cstring>

#import "SyphonServerBase.h"

// (SyphonSubclassing.h's methods, implemented in SyphonServerBase.m.)
@interface SyphonServerBase (SyphonSubclassing)
- (nullable IOSurfaceRef)newSurfaceForWidth:(size_t)width height:(size_t)height options:(nullable NSDictionary<NSString *, id> *)options;
- (void)destroySurface;
- (void)publish;
@end

namespace {

class Server : public Napi::ObjectWrap<Server> {
 public:
  static Napi::Object Init(Napi::Env env, Napi::Object exports) {
    Napi::Function f = DefineClass(env, "Server",
                                   {
                                       InstanceMethod("publish", &Server::Publish),
                                       InstanceMethod("hasClients", &Server::HasClients),
                                       InstanceMethod("stop", &Server::Stop),
                                       InstanceAccessor("name", &Server::GetName, &Server::SetName),
                                   });
    exports.Set("Server", f);
    return exports;
  }

  explicit Server(const Napi::CallbackInfo& info) : Napi::ObjectWrap<Server>(info) {
    std::string name = info.Length() > 0 && info[0].IsString() ? info[0].As<Napi::String>().Utf8Value() : std::string("Output");
    @autoreleasepool {
      server_ = [[SyphonServerBase alloc] initWithName:[NSString stringWithUTF8String:name.c_str()] options:nil];
    }
    if (!server_) Napi::Error::New(info.Env(), "couldn't start the Syphon server").ThrowAsJavaScriptException();
  }

  ~Server() { Close(); }

 private:
  void Close() {
    if (!server_) return;
    @autoreleasepool {
      [server_ stop];
      server_ = nil;
    }
  }

  // publish(buffer, width, height, flip): true once the frame is in the surface and announced.
  Napi::Value Publish(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (!server_) return Napi::Boolean::New(env, false);
    if (info.Length() < 3 || !info[0].IsBuffer() || !info[1].IsNumber() || !info[2].IsNumber()) {
      Napi::TypeError::New(env, "publish(buffer, width, height, bottomUp)").ThrowAsJavaScriptException();
      return env.Undefined();
    }
    auto buf = info[0].As<Napi::Buffer<uint8_t>>();
    const size_t w = info[1].As<Napi::Number>().Uint32Value();
    const size_t h = info[2].As<Napi::Number>().Uint32Value();
    const bool bottomUp = info.Length() > 3 && info[3].ToBoolean().Value();
    const size_t row = w * 4;
    if (!w || !h || buf.Length() < row * h) {
      Napi::RangeError::New(env, "publish: the buffer is smaller than width × height × 4").ThrowAsJavaScriptException();
      return env.Undefined();
    }
    @autoreleasepool {
      IOSurfaceRef surface = [server_ newSurfaceForWidth:w height:h options:nil];
      if (!surface) return Napi::Boolean::New(env, false);
      if (IOSurfaceLock(surface, 0, nullptr) != kIOReturnSuccess) {
        CFRelease(surface);
        return Napi::Boolean::New(env, false);
      }
      uint8_t* dst = static_cast<uint8_t*>(IOSurfaceGetBaseAddress(surface));
      const size_t stride = IOSurfaceGetBytesPerRow(surface);
      const uint8_t* src = buf.Data();
      for (size_t y = 0; y < h; y++) {
        const uint32_t* s = reinterpret_cast<const uint32_t*>(src + (bottomUp ? h - 1 - y : y) * row);
        uint32_t* d = reinterpret_cast<uint32_t*>(dst + y * stride);
        // (Opaque: the page has no transparency meant for anyone, and a client that keys on alpha
        // would otherwise show holes.)
        for (size_t x = 0; x < w; x++) d[x] = s[x] | 0xFF000000u;
      }
      IOSurfaceUnlock(surface, 0, nullptr);
      [server_ publish];
      CFRelease(surface);
    }
    return Napi::Boolean::New(env, true);
  }

  Napi::Value HasClients(const Napi::CallbackInfo& info) {
    return Napi::Boolean::New(info.Env(), server_ && server_.hasClients);
  }

  Napi::Value Stop(const Napi::CallbackInfo& info) {
    Close();
    return info.Env().Undefined();
  }

  Napi::Value GetName(const Napi::CallbackInfo& info) {
    if (!server_) return info.Env().Null();
    @autoreleasepool {
      return Napi::String::New(info.Env(), server_.name.UTF8String ?: "");
    }
  }

  void SetName(const Napi::CallbackInfo& info, const Napi::Value& value) {
    if (!server_ || !value.IsString()) return;
    std::string name = value.As<Napi::String>().Utf8Value();
    @autoreleasepool {
      server_.name = [NSString stringWithUTF8String:name.c_str()];
    }
  }

  SyphonServerBase* server_ = nil;
};

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  return Server::Init(env, exports);
}

}  // namespace

NODE_API_MODULE(syphon, Init)
