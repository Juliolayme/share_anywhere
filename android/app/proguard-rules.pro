# kotlinx.serialization: keep generated serializers of @Serializable API models (data/api).
-keepclassmembers @kotlinx.serialization.Serializable class app.shareanywhere.** {
    *** Companion;
    kotlinx.serialization.KSerializer serializer(...);
}
-keepclasseswithmembers class app.shareanywhere.** {
    kotlinx.serialization.KSerializer serializer(...);
}
