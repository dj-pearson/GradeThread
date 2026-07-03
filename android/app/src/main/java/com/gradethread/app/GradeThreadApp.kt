package com.gradethread.app

import android.app.Application
import dagger.hilt.android.HiltAndroidApp

/**
 * US-1300: Hilt application root. Feature graph modules install into this
 * SingletonComponent as they land (networking, sync, telemetry…).
 */
@HiltAndroidApp
class GradeThreadApp : Application()
