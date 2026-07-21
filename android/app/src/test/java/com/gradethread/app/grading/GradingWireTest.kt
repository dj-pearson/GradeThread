package com.gradethread.app.grading

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * US-1336: the grading bridge wire contract.
 */
class GradingWireTest {

    @Test
    fun `the request body matches the edge's strict schema exactly`() {
        // The edge validates with `.strict()`, so an extra key — including a
        // null an encoder decided to emit — 400s the whole submission rather
        // than being ignored.
        val encoded = gradingJson.encodeToString(
            GradingRequestBody.serializer(),
            GradingRequestBody.single("11111111-2222-3333-4444-555555555555", GradeTier.PREMIUM),
        )
        assertEquals(
            """{"items":[{"inventory_item_id":"11111111-2222-3333-4444-555555555555","tier":"premium"}]}""",
            encoded,
        )
    }

    @Test
    fun `the validate response decodes plan posture and blockers`() {
        val response = gradingJson.decodeFromString(
            GradingValidateResponse.serializer(),
            """
            {
              "user": {"plan":"pro","grades_used_this_month":4,"plan_limit":10,
                       "grades_remaining":9,"included_remaining":6,"credit_balance":3},
              "items": [{"inventory_item_id":"i1","tier":"standard","cost":2.99,"ready":false,
                         "blockers":["Missing back photo"],"title":"Patagonia fleece",
                         "garment_type":"outerwear","garment_category":"jacket",
                         "required_photo_types_missing":["back"]}],
              "total_cost": 2.99, "credits_required": 1,
              "can_submit": false, "limit_exceeded": false
            }
            """.trimIndent(),
        )
        assertEquals(6, response.user.includedRemaining)
        assertEquals(listOf("Missing back photo"), response.item?.blockers)
        assertEquals(listOf("back"), response.item?.requiredPhotoTypesMissing)
        assertFalse(response.canSubmit)
    }

    @Test
    fun `the status response decodes the report and the nested item`() {
        val response = gradingJson.decodeFromString(
            GradingStatusResponse.serializer(),
            """
            {"id":"b1","inventory_item_id":"i1","submission_id":"s1","tier":"standard",
             "status":"completed","cost":2.99,"submitted_at":"2026-07-21T00:00:00Z",
             "graded_at":"2026-07-21T00:01:00Z","error":null,
             "item":{"title":"Fleece","grade_value":8.2,"grade_label":"Excellent",
                     "certificate_url":"https://gradethread.com/cert/abc"},
             "grade_report":{"id":"r1","overall_score":8.2,"grade_tier":"Excellent",
               "fabric_condition_score":8.0,"structural_integrity_score":8.5,
               "cosmetic_appearance_score":8.0,"functional_elements_score":9.0,
               "odor_cleanliness_score":8.0,"ai_summary":"Light pilling.",
               "confidence_score":0.91,"certificate_id":"abc",
               "created_at":"2026-07-21T00:01:00Z"}}
            """.trimIndent(),
        )
        assertEquals("completed", response.status)
        assertEquals(0.91, response.gradeReport?.confidenceScore ?: 0.0, 0.001)
        assertEquals("https://gradethread.com/cert/abc", response.item.certificateUrl)
        // And it classifies as done, end to end.
        assertTrue(GradeRequestMachine.classify(response) is GradeRequestMachine.Phase.Completed)
    }

    @Test
    fun `an unknown tier on the wire falls back to standard rather than crashing`() {
        assertEquals(GradeTier.STANDARD, GradeTier.fromWire("platinum"))
        assertEquals(GradeTier.STANDARD, GradeTier.fromWire(null))
        assertEquals(GradeTier.EXPRESS, GradeTier.fromWire("express"))
    }

    @Test
    fun `tier credit costs mirror the edge pricing table`() {
        assertEquals(1, GradeTier.STANDARD.creditCost)
        assertEquals(3, GradeTier.PREMIUM.creditCost)
        assertEquals(5, GradeTier.EXPRESS.creditCost)
    }
}
