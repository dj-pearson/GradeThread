package com.gradethread.app.referrals

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * US-1385: the wire shape.
 *
 * The edge grew `credits` and `milestones` after the first clients shipped, so
 * these prove an old payload still decodes and a new one is fully read. A
 * strict decode here would take the whole screen down for a field nobody looks
 * at.
 */
class ReferralDecodeTest {

    private val json = Json { ignoreUnknownKeys = true; isLenient = true }

    private fun decode(raw: String) = json.decodeFromString(ReferralMe.serializer(), raw)

    @Test
    fun `the full payload decodes`() {
        val me = decode(
            """
            {
              "code": "ABCD2345",
              "stats": { "total": 7, "pending": 2, "qualified": 1, "granted": 3 },
              "credits": { "per_referral": 5, "earned": 15, "pending": 20 },
              "milestones": {
                "tiers": [{ "threshold": 5, "bonus": 25 }],
                "earned_thresholds": [3],
                "earned_bonus_credits": 10,
                "next": { "threshold": 5, "bonus": 25, "remaining": 2 }
              },
              "leaderboard": { "enabled": true, "display_name": "Dj" },
              "referred_by": { "status": "pending", "code": "FRIEND" }
            }
            """.trimIndent(),
        )

        assertEquals("ABCD2345", me.code)
        assertEquals(7, me.stats.total)
        assertEquals(5, me.credits.perReferral)
        assertEquals(2, me.milestones.next?.remaining)
        assertEquals("FRIEND", me.referredBy?.code)
    }

    @Test
    fun `an older payload without credits or milestones still decodes`() {
        val me = decode(
            """{ "code": "OLD1", "stats": { "total": 1, "pending": 1, "qualified": 0, "granted": 0 } }""",
        )

        assertEquals("OLD1", me.code)
        assertEquals(0, me.credits.perReferral)
        assertNull(me.milestones.next)
        assertNull(me.referredBy)
    }

    @Test
    fun `fields this build has never heard of are ignored`() {
        // The edge adds keys ahead of the clients; a strict decode would take
        // the screen down over one nobody reads.
        val me = decode(
            """{ "code": "NEW1", "stats": { "total": 0 }, "leaderboard": { "enabled": false },
                 "some_future_thing": { "deeply": ["nested"] } }""",
        )

        assertEquals("NEW1", me.code)
        assertEquals(0, me.stats.granted)
    }

    @Test
    fun `a never-referred user has no referred_by`() {
        val me = decode("""{ "code": "X", "referred_by": null }""")

        assertNull(me.referredBy)
        assertNull(Referrals.referredByLabel(me.referredBy))
        assertTrue(Referrals.canRedeem(me, "FRIEND", busy = false))
    }
}
