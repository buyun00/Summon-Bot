package org.lin0.relay

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Box
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay

@Composable
fun Modifier.summonPress(onClick: () -> Unit): Modifier {
    val source=remember{MutableInteractionSource()}
    val pressed by source.collectIsPressedAsState()
    val scale by animateFloatAsState(if(pressed) .94f else 1f,spring(dampingRatio=.65f,stiffness=650f),label="button press")
    return graphicsLayer{scaleX=scale;scaleY=scale}.clickable(interactionSource=source,indication=androidx.compose.material3.ripple(),role=Role.Button,onClick=onClick)
}

@Composable
fun GreetingAvatar(avatar: SummonAvatar) {
    val size=remember{Animatable(.08f)}
    var greeting by remember{mutableIntStateOf(0)}
    var expression by remember{mutableStateOf("expression:heureux")}
    LaunchedEffect(Unit){
        if(!android.animation.ValueAnimator.areAnimatorsEnabled())size.snapTo(1f)
        else {delay(120);size.animateTo(1f,spring(dampingRatio=.58f,stiffness=130f))}
    }
    LaunchedEffect(greeting){
        if(!android.animation.ValueAnimator.areAnimatorsEnabled()){expression="idle";return@LaunchedEffect}
        expression="expression:heureux"
        while(true){delay(1800);expression="idle";delay(4000);expression=listOf("expression:curieux","expression:heureux","expression:attentif").random()}
    }
    Box(Modifier.summonPress { greeting++ }) {
        BotAvatar(avatar.shape,avatar.color,avatar.image,148.dp,
            modifier=Modifier.graphicsLayer{scaleX=size.value;scaleY=size.value;alpha=size.value.coerceIn(0f,1f)},
            secondary=avatar.secondary,ink=avatar.ink,paper=avatar.paper,motion=expression)
    }
}
