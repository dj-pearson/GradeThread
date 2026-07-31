# US-1300 / US-1391: app-specific R8 rules.
#
# Most libraries ship consumer rules inside their AARs (Room, Hilt, Glance,
# Sentry, PostHog, ML Kit, Firebase, Play Billing, OkHttp, Ktor) and need
# nothing here. What follows is only what this app's own shape requires, plus
# the dontwarn entries for optional dependencies those libraries reference but
# never load on Android.
#
# Rule of thumb kept from US-1300: add an entry only when a release build proves
# it is needed. Every keep that is not needed is dead weight in the APK and a
# reflection surface left open.

# ── kotlinx.serialization ────────────────────────────────────────────────────
#
# Every wire model in this app is @Serializable, and the compiler plugin puts
# the generated serializer in a `$$serializer` nested class reached only through
# reflection on the companion. R8 cannot see that reference, so without these
# the release build strips the serializers and every decode throws
# `SerializationException` at runtime — a failure that does not exist in debug.
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.**

-keepclassmembers class kotlinx.serialization.json.** {
    *** Companion;
}
-keepclasseswithmembers class kotlinx.serialization.json.** {
    kotlinx.serialization.KSerializer serializer(...);
}

# The app's own serializable types and their generated serializers.
-keep,includedescriptorclasses class com.gradethread.app.**$$serializer { *; }
-keepclassmembers class com.gradethread.app.** {
    *** Companion;
}
-keepclasseswithmembers class com.gradethread.app.** {
    kotlinx.serialization.KSerializer serializer(...);
}

# ── Enums ────────────────────────────────────────────────────────────────────
#
# US-1390 saves enums by NAME across process death, and several wire enums are
# resolved by `valueOf`. R8 rewrites enum internals unless told otherwise.
-keepclassmembers enum com.gradethread.app.** {
    public static **[] values();
    public static ** valueOf(java.lang.String);
}

# ── Optional dependencies referenced but never loaded ────────────────────────
#
# Ktor and its transitive graph reference server-side and JVM-desktop classes
# that are absent on Android. R8 treats a missing class as an error, so these
# have to be named or the release build fails on code no Android device runs.
-dontwarn org.slf4j.**
-dontwarn java.lang.management.**
-dontwarn javax.naming.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**
-dontwarn kotlinx.coroutines.debug.**
-dontwarn io.ktor.network.**
-dontwarn reactor.blockhound.**
