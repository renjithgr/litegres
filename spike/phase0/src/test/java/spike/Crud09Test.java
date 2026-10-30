package spike;

import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

class Crud09Test extends CrudSuite {
    @DynamicPropertySource
    static void props(DynamicPropertyRegistry r) { register(r, "Crud09"); }
}
