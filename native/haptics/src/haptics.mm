// Minimal bridge to macOS trackpad haptics.
//
// NSHapticFeedbackManager only produces anything on a Force Touch trackpad
// while the user's hand is actually resting on it — an external mouse, or a
// press via the keyboard, is silently a no-op. That's expected; there is no
// fallback and no way to query for one.
//
// Pinned to NAPI_VERSION 8 so the built binary stays ABI-compatible with the
// Electron runtime it's loaded into.

#import <AppKit/AppKit.h>
#include <napi.h>

static NSHapticFeedbackPattern PatternFromString(const std::string &name) {
  if (name == "level") return NSHapticFeedbackPatternLevelChange;
  if (name == "alignment") return NSHapticFeedbackPatternAlignment;
  return NSHapticFeedbackPatternGeneric;
}

static void Perform(const Napi::CallbackInfo &info) {
  NSHapticFeedbackPattern pattern = NSHapticFeedbackPatternGeneric;
  if (info.Length() > 0 && info[0].IsString()) {
    pattern = PatternFromString(info[0].As<Napi::String>().Utf8Value());
  }

  // The performer must be driven on the main thread; Electron's main process
  // calls us from there already, but hop deliberately rather than assume it.
  dispatch_block_t tap = ^{
    [[NSHapticFeedbackManager defaultPerformer]
        performFeedbackPattern:pattern
               performanceTime:NSHapticFeedbackPerformanceTimeNow];
  };

  if ([NSThread isMainThread]) {
    tap();
  } else {
    dispatch_async(dispatch_get_main_queue(), tap);
  }
}

static Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("perform", Napi::Function::New(env, Perform));
  return exports;
}

NODE_API_MODULE(haptics, Init)
