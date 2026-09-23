#include <ApplicationServices/ApplicationServices.h>
#include <CoreFoundation/CoreFoundation.h>
#include <dlfcn.h>
#include <node_api.h>
#include <pthread.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

typedef void (*openhistory_collector_event_callback)(const char *, void *);

extern int32_t openhistory_collector_start(
    const char *data_directory,
    const char *configuration_json,
    openhistory_collector_event_callback callback,
    void *context
);
extern void openhistory_collector_stop(void);
extern int32_t openhistory_collector_set_foreground_observation(uint64_t generation);
extern int32_t openhistory_focus_overlay_show(const char *request_json);
extern void openhistory_focus_overlay_hide(const char *nudge_id, bool immediate);
extern void openhistory_focus_overlay_set_action_callback(
    openhistory_collector_event_callback callback,
    void *context
);
extern void openhistory_focus_overlay_shutdown(void);
extern int32_t openhistory_focus_bar_update(const char *snapshot_json);
extern void openhistory_focus_bar_hide(void);
extern void openhistory_focus_bar_focus(void);
extern void openhistory_focus_bar_set_action_callback(
    openhistory_collector_event_callback callback,
    void *context
);
extern void openhistory_focus_bar_shutdown(void);
extern int32_t openhistory_timer_bar_update(const char *request_json);
extern void openhistory_timer_bar_shutdown(void);

static napi_threadsafe_function collector_events = NULL;
static napi_threadsafe_function focus_actions = NULL;
static napi_threadsafe_function focus_bar_actions = NULL;
static bool cleanup_hook_installed = false;

static napi_value boolean_value(napi_env env, bool value) {
    napi_value result;
    if (napi_get_boolean(env, value, &result) != napi_ok) return NULL;
    return result;
}

static napi_value undefined_value(napi_env env) {
    napi_value result;
    if (napi_get_undefined(env, &result) != napi_ok) return NULL;
    return result;
}

static char *copy_utf8_argument(napi_env env, napi_value value, const char *label) {
    napi_valuetype type;
    if (napi_typeof(env, value, &type) != napi_ok || type != napi_string) {
        napi_throw_type_error(env, NULL, label);
        return NULL;
    }
    size_t length = 0;
    if (napi_get_value_string_utf8(env, value, NULL, 0, &length) != napi_ok) return NULL;
    char *buffer = calloc(length + 1, sizeof(char));
    if (buffer == NULL) {
        napi_throw_error(env, NULL, "Unable to allocate native collector input");
        return NULL;
    }
    if (napi_get_value_string_utf8(env, value, buffer, length + 1, &length) != napi_ok) {
        free(buffer);
        return NULL;
    }
    return buffer;
}

static void deliver_collector_event(
    napi_env env,
    napi_value javascript_callback,
    void *context,
    void *data
) {
    (void)context;
    char *line = data;
    if (env != NULL && javascript_callback != NULL && line != NULL) {
        napi_value receiver;
        napi_value argument;
        napi_value ignored;
        if (napi_get_undefined(env, &receiver) == napi_ok &&
            napi_create_string_utf8(env, line, NAPI_AUTO_LENGTH, &argument) == napi_ok) {
            napi_call_function(env, receiver, javascript_callback, 1, &argument, &ignored);
        }
    }
    free(line);
}

static void receive_collector_event(const char *line, void *context) {
    (void)context;
    if (line == NULL || collector_events == NULL) return;
    char *copy = strdup(line);
    if (copy == NULL) return;
    napi_status status = napi_call_threadsafe_function(
        collector_events,
        copy,
        napi_tsfn_nonblocking
    );
    if (status != napi_ok) free(copy);
}

static void stop_embedded_collector(void) {
    openhistory_collector_stop();
    if (collector_events != NULL) {
        napi_release_threadsafe_function(collector_events, napi_tsfn_release);
        collector_events = NULL;
    }
}

static napi_value start_collector(napi_env env, napi_callback_info info) {
    size_t argument_count = 3;
    napi_value arguments[3];
    if (napi_get_cb_info(env, info, &argument_count, arguments, NULL, NULL) != napi_ok) {
        return NULL;
    }
    if (argument_count != 3) {
        napi_throw_type_error(env, NULL, "startCollector requires a data directory, configuration JSON, and event callback");
        return NULL;
    }

    napi_valuetype callback_type;
    if (napi_typeof(env, arguments[2], &callback_type) != napi_ok || callback_type != napi_function) {
        napi_throw_type_error(env, NULL, "startCollector event callback must be a function");
        return NULL;
    }

    char *data_directory = copy_utf8_argument(env, arguments[0], "startCollector data directory must be a string");
    if (data_directory == NULL) return NULL;
    char *configuration_json = copy_utf8_argument(env, arguments[1], "startCollector configuration must be JSON text");
    if (configuration_json == NULL) {
        free(data_directory);
        return NULL;
    }

    stop_embedded_collector();
    napi_value resource_name;
    napi_status status = napi_create_string_utf8(
        env,
        "OpenHistory collector events",
        NAPI_AUTO_LENGTH,
        &resource_name
    );
    if (status == napi_ok) {
        status = napi_create_threadsafe_function(
            env,
            arguments[2],
            NULL,
            resource_name,
            4096,
            1,
            NULL,
            NULL,
            NULL,
            deliver_collector_event,
            &collector_events
        );
    }
    if (status != napi_ok) {
        free(data_directory);
        free(configuration_json);
        napi_throw_error(env, NULL, "Unable to create the native collector event channel");
        return NULL;
    }

    int32_t result = openhistory_collector_start(
        data_directory,
        configuration_json,
        receive_collector_event,
        NULL
    );
    free(data_directory);
    free(configuration_json);
    if (result != 0) {
        stop_embedded_collector();
        napi_throw_error(env, NULL, "The native collector could not start");
        return NULL;
    }
    return boolean_value(env, true);
}

static napi_value stop_collector(napi_env env, napi_callback_info info) {
    (void)info;
    stop_embedded_collector();
    return undefined_value(env);
}

static napi_value set_foreground_observation(napi_env env, napi_callback_info info) {
    size_t argument_count = 1;
    napi_value argument;
    if (napi_get_cb_info(env, info, &argument_count, &argument, NULL, NULL) != napi_ok) return NULL;
    int64_t generation = -1;
    if (argument_count != 1 || napi_get_value_int64(env, argument, &generation) != napi_ok ||
        generation < 0 || generation > 9007199254740991LL) {
        napi_throw_type_error(env, NULL, "setForegroundObservation requires a nonnegative integer generation");
        return NULL;
    }
    return boolean_value(env, openhistory_collector_set_foreground_observation((uint64_t)generation) == 0);
}

static void release_focus_actions(void) {
    openhistory_focus_overlay_set_action_callback(NULL, NULL);
    if (focus_actions != NULL) {
        napi_release_threadsafe_function(focus_actions, napi_tsfn_release);
        focus_actions = NULL;
    }
}

static void receive_focus_action(const char *line, void *context) {
    (void)context;
    if (line == NULL || focus_actions == NULL) return;
    char *copy = strdup(line);
    if (copy == NULL) return;
    if (napi_call_threadsafe_function(focus_actions, copy, napi_tsfn_nonblocking) != napi_ok) free(copy);
}

static void release_focus_bar_actions(void) {
    openhistory_focus_bar_set_action_callback(NULL, NULL);
    if (focus_bar_actions != NULL) {
        napi_release_threadsafe_function(focus_bar_actions, napi_tsfn_release);
        focus_bar_actions = NULL;
    }
}

static void receive_focus_bar_action(const char *line, void *context) {
    (void)context;
    if (line == NULL || focus_bar_actions == NULL) return;
    char *copy = strdup(line);
    if (copy == NULL) return;
    if (napi_call_threadsafe_function(focus_bar_actions, copy, napi_tsfn_nonblocking) != napi_ok) free(copy);
}

static void cleanup_native_bridge(void *argument) {
    (void)argument;
    // Node finalizes thread-safe functions during environment teardown before this hook runs, so
    // only detach native producers here and forget the handles instead of releasing them again.
    openhistory_focus_overlay_set_action_callback(NULL, NULL);
    openhistory_focus_bar_set_action_callback(NULL, NULL);
    openhistory_focus_bar_shutdown();
    openhistory_timer_bar_shutdown();
    openhistory_focus_overlay_shutdown();
    openhistory_collector_stop();
    focus_bar_actions = NULL;
    focus_actions = NULL;
    collector_events = NULL;
}

static napi_value set_focus_overlay_action_handler(napi_env env, napi_callback_info info) {
    size_t argument_count = 1;
    napi_value argument;
    if (napi_get_cb_info(env, info, &argument_count, &argument, NULL, NULL) != napi_ok) return NULL;
    napi_valuetype type = napi_undefined;
    if (argument_count >= 1 && napi_typeof(env, argument, &type) != napi_ok) return NULL;

    release_focus_actions();
    if (type == napi_undefined || type == napi_null) return undefined_value(env);
    if (type != napi_function) {
        napi_throw_type_error(env, NULL, "setFocusOverlayActionHandler requires a function or null");
        return NULL;
    }

    napi_value resource_name;
    napi_status status = napi_create_string_utf8(
        env,
        "OpenHistory focus overlay actions",
        NAPI_AUTO_LENGTH,
        &resource_name
    );
    if (status == napi_ok) {
        status = napi_create_threadsafe_function(
            env, argument, NULL, resource_name, 64, 1,
            NULL, NULL, NULL, deliver_collector_event, &focus_actions
        );
    }
    if (status != napi_ok) {
        focus_actions = NULL;
        napi_throw_error(env, NULL, "Unable to create the focus overlay action channel");
        return NULL;
    }
    // Reminder actions must never keep the process alive on their own.
    napi_unref_threadsafe_function(env, focus_actions);
    openhistory_focus_overlay_set_action_callback(receive_focus_action, NULL);
    return undefined_value(env);
}

static napi_value show_focus_overlay(napi_env env, napi_callback_info info) {
    size_t argument_count = 1;
    napi_value argument;
    if (napi_get_cb_info(env, info, &argument_count, &argument, NULL, NULL) != napi_ok) return NULL;
    if (argument_count != 1) {
        napi_throw_type_error(env, NULL, "showFocusOverlay requires request JSON");
        return NULL;
    }
    char *request_json = copy_utf8_argument(env, argument, "showFocusOverlay request must be JSON text");
    if (request_json == NULL) return NULL;
    int32_t result = openhistory_focus_overlay_show(request_json);
    free(request_json);
    napi_value value;
    if (napi_create_int32(env, result, &value) != napi_ok) return NULL;
    return value;
}

static napi_value hide_focus_overlay(napi_env env, napi_callback_info info) {
    size_t argument_count = 2;
    napi_value arguments[2];
    if (napi_get_cb_info(env, info, &argument_count, arguments, NULL, NULL) != napi_ok) return NULL;
    if (argument_count != 2) {
        napi_throw_type_error(env, NULL, "hideFocusOverlay requires a reminder identifier and an immediate flag");
        return NULL;
    }
    bool immediate = false;
    if (napi_get_value_bool(env, arguments[1], &immediate) != napi_ok) {
        napi_throw_type_error(env, NULL, "hideFocusOverlay immediate flag must be a boolean");
        return NULL;
    }
    char *nudge_id = copy_utf8_argument(env, arguments[0], "hideFocusOverlay reminder identifier must be a string");
    if (nudge_id == NULL) return NULL;
    openhistory_focus_overlay_hide(nudge_id, immediate);
    free(nudge_id);
    return undefined_value(env);
}

static napi_value set_focus_bar_action_handler(napi_env env, napi_callback_info info) {
    size_t argument_count = 1;
    napi_value argument;
    if (napi_get_cb_info(env, info, &argument_count, &argument, NULL, NULL) != napi_ok) return NULL;
    napi_valuetype type = napi_undefined;
    if (argument_count >= 1 && napi_typeof(env, argument, &type) != napi_ok) return NULL;

    release_focus_bar_actions();
    if (type == napi_undefined || type == napi_null) return undefined_value(env);
    if (type != napi_function) {
        napi_throw_type_error(env, NULL, "setFocusBarActionHandler requires a function or null");
        return NULL;
    }

    napi_value resource_name;
    napi_status status = napi_create_string_utf8(
        env,
        "OpenHistory focus bar actions",
        NAPI_AUTO_LENGTH,
        &resource_name
    );
    if (status == napi_ok) {
        status = napi_create_threadsafe_function(
            env, argument, NULL, resource_name, 64, 1,
            NULL, NULL, NULL, deliver_collector_event, &focus_bar_actions
        );
    }
    if (status != napi_ok) {
        focus_bar_actions = NULL;
        napi_throw_error(env, NULL, "Unable to create the focus bar action channel");
        return NULL;
    }
    // Bar clicks must never keep the process alive on their own.
    napi_unref_threadsafe_function(env, focus_bar_actions);
    openhistory_focus_bar_set_action_callback(receive_focus_bar_action, NULL);
    return undefined_value(env);
}

static napi_value update_focus_bar(napi_env env, napi_callback_info info) {
    size_t argument_count = 1;
    napi_value argument;
    if (napi_get_cb_info(env, info, &argument_count, &argument, NULL, NULL) != napi_ok) return NULL;
    if (argument_count != 1) {
        napi_throw_type_error(env, NULL, "updateFocusBar requires snapshot JSON");
        return NULL;
    }
    char *snapshot_json = copy_utf8_argument(env, argument, "updateFocusBar snapshot must be JSON text");
    if (snapshot_json == NULL) return NULL;
    int32_t result = openhistory_focus_bar_update(snapshot_json);
    free(snapshot_json);
    napi_value value;
    if (napi_create_int32(env, result, &value) != napi_ok) return NULL;
    return value;
}

static napi_value hide_focus_bar(napi_env env, napi_callback_info info) {
    (void)info;
    openhistory_focus_bar_hide();
    return undefined_value(env);
}

// Only reached from an explicit request, because it takes keyboard focus.
static napi_value focus_focus_bar(napi_env env, napi_callback_info info) {
    (void)info;
    openhistory_focus_bar_focus();
    return undefined_value(env);
}

static napi_value update_timer_bar(napi_env env, napi_callback_info info) {
    size_t argument_count = 1;
    napi_value argument;
    if (napi_get_cb_info(env, info, &argument_count, &argument, NULL, NULL) != napi_ok) return NULL;
    if (argument_count != 1) {
        napi_throw_type_error(env, NULL, "updateTimerBar requires request JSON");
        return NULL;
    }
    char *request_json = copy_utf8_argument(env, argument, "updateTimerBar request must be JSON text");
    if (request_json == NULL) return NULL;
    int32_t result = openhistory_timer_bar_update(request_json);
    free(request_json);
    napi_value value;
    if (napi_create_int32(env, result, &value) != napi_ok) return NULL;
    return value;
}

static napi_value shutdown_timer_bar(napi_env env, napi_callback_info info) {
    (void)info;
    openhistory_timer_bar_shutdown();
    return undefined_value(env);
}

static napi_value is_trusted(napi_env env, napi_callback_info info) {
    (void)info;
    return boolean_value(env, AXIsProcessTrusted());
}

static napi_value request_trust(napi_env env, napi_callback_info info) {
    (void)info;
    const void *keys[] = { kAXTrustedCheckOptionPrompt };
    const void *values[] = { kCFBooleanTrue };
    CFDictionaryRef options = CFDictionaryCreate(
        kCFAllocatorDefault,
        keys,
        values,
        1,
        &kCFTypeDictionaryKeyCallBacks,
        &kCFTypeDictionaryValueCallBacks
    );
    Boolean trusted = options == NULL
        ? AXIsProcessTrusted()
        : AXIsProcessTrustedWithOptions(options);
    if (options != NULL) CFRelease(options);
    return boolean_value(env, trusted);
}

// Never prompts. The grayscale reminder captures only while this is true.
static napi_value screen_capture_access(napi_env env, napi_callback_info info) {
    (void)info;
    return boolean_value(env, CGPreflightScreenCaptureAccess());
}

// Only called from an explicit "Grant Screen Recording" click. macOS shows its prompt at most once.
static napi_value request_screen_capture_access(napi_env env, napi_callback_info info) {
    (void)info;
    return boolean_value(env, CGRequestScreenCaptureAccess());
}

// macOS has no public API for the system Color Filters preference. These private symbols are
// resolved with dlsym rather than linked so a missing or renamed symbol leaves the feature
// unavailable instead of preventing the bridge from loading.
#define SYSTEM_COLOR_FILTER_CATEGORY 1
#define UNIVERSAL_ACCESS_DISPLAY_FILTER_WAKE 8

typedef bool (*display_filter_get_enabled_function)(int);
typedef void (*display_filter_set_enabled_function)(int, bool);
typedef int (*display_filter_get_type_function)(int);
typedef void (*display_filter_set_type_function)(int, int);
typedef void (*universal_access_start_function)(int);

static pthread_once_t display_filter_once = PTHREAD_ONCE_INIT;
static bool display_filter_available = false;
static display_filter_get_enabled_function display_filter_get_enabled = NULL;
static display_filter_set_enabled_function display_filter_set_enabled = NULL;
static display_filter_get_type_function display_filter_get_type = NULL;
static display_filter_set_type_function display_filter_set_type = NULL;
static universal_access_start_function universal_access_start = NULL;

static void load_display_filter_symbols(void) {
    void *media_accessibility = dlopen(
        "/System/Library/Frameworks/MediaAccessibility.framework/MediaAccessibility",
        RTLD_LAZY | RTLD_LOCAL
    );
    void *universal_access = dlopen("/usr/lib/libUniversalAccess.dylib", RTLD_LAZY | RTLD_LOCAL);
    if (media_accessibility != NULL && universal_access != NULL) {
        display_filter_get_enabled = (display_filter_get_enabled_function)dlsym(
            media_accessibility, "MADisplayFilterPrefGetCategoryEnabled");
        display_filter_set_enabled = (display_filter_set_enabled_function)dlsym(
            media_accessibility, "MADisplayFilterPrefSetCategoryEnabled");
        display_filter_get_type = (display_filter_get_type_function)dlsym(
            media_accessibility, "MADisplayFilterPrefGetType");
        display_filter_set_type = (display_filter_set_type_function)dlsym(
            media_accessibility, "MADisplayFilterPrefSetType");
        universal_access_start = (universal_access_start_function)dlsym(
            universal_access, "_UniversalAccessDStart");
    }
    display_filter_available = display_filter_get_enabled != NULL &&
        display_filter_set_enabled != NULL &&
        display_filter_get_type != NULL &&
        display_filter_set_type != NULL &&
        universal_access_start != NULL;
    if (display_filter_available) return;

    display_filter_get_enabled = NULL;
    display_filter_set_enabled = NULL;
    display_filter_get_type = NULL;
    display_filter_set_type = NULL;
    universal_access_start = NULL;
    if (media_accessibility != NULL) dlclose(media_accessibility);
    if (universal_access != NULL) dlclose(universal_access);
}

static bool display_filter_symbols_loaded(void) {
    return pthread_once(&display_filter_once, load_display_filter_symbols) == 0 &&
        display_filter_available;
}

static napi_value system_color_filter_read(napi_env env, napi_callback_info info) {
    (void)info;
    napi_value result;
    if (!display_filter_symbols_loaded()) {
        if (napi_get_null(env, &result) != napi_ok) return NULL;
        return result;
    }
    bool enabled = display_filter_get_enabled(SYSTEM_COLOR_FILTER_CATEGORY);
    int type = display_filter_get_type(SYSTEM_COLOR_FILTER_CATEGORY);

    napi_value enabled_value = boolean_value(env, enabled);
    napi_value type_value;
    if (enabled_value == NULL ||
        napi_create_int32(env, (int32_t)type, &type_value) != napi_ok ||
        napi_create_object(env, &result) != napi_ok ||
        napi_set_named_property(env, result, "enabled", enabled_value) != napi_ok ||
        napi_set_named_property(env, result, "type", type_value) != napi_ok) {
        return NULL;
    }
    return result;
}

static napi_value system_color_filter_write(napi_env env, napi_callback_info info) {
    size_t argument_count = 2;
    napi_value arguments[2];
    if (napi_get_cb_info(env, info, &argument_count, arguments, NULL, NULL) != napi_ok) return NULL;
    if (argument_count != 2) {
        napi_throw_type_error(env, NULL, "systemColorFilterWrite requires an enabled flag and a filter type");
        return NULL;
    }
    bool enabled = false;
    if (napi_get_value_bool(env, arguments[0], &enabled) != napi_ok) {
        napi_throw_type_error(env, NULL, "systemColorFilterWrite enabled flag must be a boolean");
        return NULL;
    }
    napi_valuetype type_kind;
    double requested_type = 0;
    if (napi_typeof(env, arguments[1], &type_kind) != napi_ok || type_kind != napi_number ||
        napi_get_value_double(env, arguments[1], &requested_type) != napi_ok ||
        !(requested_type >= INT32_MIN && requested_type <= INT32_MAX) ||
        requested_type != (double)(int32_t)requested_type) {
        napi_throw_type_error(env, NULL, "systemColorFilterWrite filter type must be a 32-bit integer");
        return NULL;
    }
    int type = (int)(int32_t)requested_type;

    if (!display_filter_symbols_loaded()) return boolean_value(env, false);
    display_filter_set_type(SYSTEM_COLOR_FILTER_CATEGORY, type);
    display_filter_set_enabled(SYSTEM_COLOR_FILTER_CATEGORY, enabled);
    universal_access_start(UNIVERSAL_ACCESS_DISPLAY_FILTER_WAKE);
    bool matches = display_filter_get_type(SYSTEM_COLOR_FILTER_CATEGORY) == type &&
        display_filter_get_enabled(SYSTEM_COLOR_FILTER_CATEGORY) == enabled;
    return boolean_value(env, matches);
}

static napi_value process_identifier(napi_env env, napi_callback_info info) {
    (void)info;
    napi_value result;
    if (napi_create_int64(env, (int64_t)getpid(), &result) != napi_ok) return NULL;
    return result;
}

static napi_value can_read_focused_application(napi_env env, napi_callback_info info) {
    (void)info;
    AXUIElementRef system_wide = AXUIElementCreateSystemWide();
    CFTypeRef focused_application = NULL;
    AXError error = AXUIElementCopyAttributeValue(
        system_wide,
        kAXFocusedApplicationAttribute,
        &focused_application
    );
    if (focused_application != NULL) CFRelease(focused_application);
    CFRelease(system_wide);
    return boolean_value(env, error == kAXErrorSuccess);
}

static napi_value bundle_identifier(napi_env env, napi_callback_info info) {
    (void)info;
    CFBundleRef bundle = CFBundleGetMainBundle();
    CFStringRef identifier = bundle == NULL ? NULL : CFBundleGetIdentifier(bundle);
    if (identifier == NULL) {
        napi_value result;
        if (napi_get_null(env, &result) != napi_ok) return NULL;
        return result;
    }

    CFIndex length = CFStringGetLength(identifier);
    CFIndex capacity = CFStringGetMaximumSizeForEncoding(length, kCFStringEncodingUTF8) + 1;
    char *buffer = calloc((size_t)capacity, sizeof(char));
    if (buffer == NULL || !CFStringGetCString(identifier, buffer, capacity, kCFStringEncodingUTF8)) {
        free(buffer);
        napi_throw_error(env, NULL, "Unable to read the host bundle identifier");
        return NULL;
    }

    napi_value result;
    napi_status status = napi_create_string_utf8(env, buffer, NAPI_AUTO_LENGTH, &result);
    free(buffer);
    if (status != napi_ok) return NULL;
    return result;
}

NAPI_MODULE_INIT() {
    napi_property_descriptor properties[] = {
        { "startCollector", NULL, start_collector, NULL, NULL, NULL, napi_default, NULL },
        { "stopCollector", NULL, stop_collector, NULL, NULL, NULL, napi_default, NULL },
        { "setForegroundObservation", NULL, set_foreground_observation, NULL, NULL, NULL, napi_default, NULL },
        { "setFocusOverlayActionHandler", NULL, set_focus_overlay_action_handler, NULL, NULL, NULL, napi_default, NULL },
        { "showFocusOverlay", NULL, show_focus_overlay, NULL, NULL, NULL, napi_default, NULL },
        { "hideFocusOverlay", NULL, hide_focus_overlay, NULL, NULL, NULL, napi_default, NULL },
        { "setFocusBarActionHandler", NULL, set_focus_bar_action_handler, NULL, NULL, NULL, napi_default, NULL },
        { "updateFocusBar", NULL, update_focus_bar, NULL, NULL, NULL, napi_default, NULL },
        { "hideFocusBar", NULL, hide_focus_bar, NULL, NULL, NULL, napi_default, NULL },
        { "focusFocusBar", NULL, focus_focus_bar, NULL, NULL, NULL, napi_default, NULL },
        { "updateTimerBar", NULL, update_timer_bar, NULL, NULL, NULL, napi_default, NULL },
        { "shutdownTimerBar", NULL, shutdown_timer_bar, NULL, NULL, NULL, napi_default, NULL },
        { "isTrusted", NULL, is_trusted, NULL, NULL, NULL, napi_default, NULL },
        { "requestTrust", NULL, request_trust, NULL, NULL, NULL, napi_default, NULL },
        { "screenCaptureAccess", NULL, screen_capture_access, NULL, NULL, NULL, napi_default, NULL },
        { "requestScreenCaptureAccess", NULL, request_screen_capture_access, NULL, NULL, NULL, napi_default, NULL },
        { "systemColorFilterRead", NULL, system_color_filter_read, NULL, NULL, NULL, napi_default, NULL },
        { "systemColorFilterWrite", NULL, system_color_filter_write, NULL, NULL, NULL, napi_default, NULL },
        { "processIdentifier", NULL, process_identifier, NULL, NULL, NULL, napi_default, NULL },
        { "canReadFocusedApplication", NULL, can_read_focused_application, NULL, NULL, NULL, napi_default, NULL },
        { "bundleIdentifier", NULL, bundle_identifier, NULL, NULL, NULL, napi_default, NULL }
    };
    if (napi_define_properties(
        env,
        exports,
        sizeof(properties) / sizeof(properties[0]),
        properties
    ) != napi_ok) {
        return NULL;
    }
    if (!cleanup_hook_installed &&
        napi_add_env_cleanup_hook(env, cleanup_native_bridge, NULL) == napi_ok) {
        cleanup_hook_installed = true;
    }
    return exports;
}
